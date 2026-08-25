//! The bounded queue unsolicited events land in.
//!
//! # Why this is not a channel
//!
//! The reader thread is the only thing that can deliver a *response*. If it
//! ever blocks feeding an event to a slow consumer, every in-flight request
//! stalls behind an observation nobody is reading. So the feeding side must
//! never wait, which rules out a rendezvous channel; and it must be bounded,
//! because Rhino fires `ObjectAdded` once per object and a scripted import
//! emits tens of thousands in a second.
//!
//! Something has to give, and it is the oldest observation. That is a real
//! loss, so it is counted rather than hidden: see [`EventQueue::dropped`] and
//! `EventEnvelope::dropped_before`. Verification reasons from event evidence,
//! and code that concludes "no `ObjectAdded` arrived, so nothing was created"
//! must be able to tell that from "the evidence was discarded".

use hii_rhino_protocol::EventEnvelope;
use std::{
    collections::VecDeque,
    sync::{Condvar, Mutex},
    time::{Duration, Instant},
};

/// How many observations are held before the oldest is discarded.
///
/// Sized for a burst rather than a backlog: enough that an ordinary operation's
/// events survive a caller that is briefly busy, small enough that a runaway
/// document cannot grow this without bound.
pub const EVENT_QUEUE_CAPACITY: usize = 1024;

#[derive(Default)]
struct State {
    events: VecDeque<EventEnvelope>,
    dropped: u64,
    closed: bool,
}

pub struct EventQueue {
    capacity: usize,
    state: Mutex<State>,
    arrived: Condvar,
}

impl EventQueue {
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(1),
            state: Mutex::new(State::default()),
            arrived: Condvar::new(),
        }
    }

    /// Add one observation. Never blocks, never fails.
    ///
    /// Returns how many were discarded to make room, which the caller records
    /// so the next event can carry it.
    pub fn push(&self, event: EventEnvelope) -> u64 {
        let mut state = self.state.lock().expect("event queue mutex");
        let mut discarded = 0;

        while state.events.len() >= self.capacity {
            // Oldest first. A new observation describes the document as it is
            // now, and is worth more than one describing how it was.
            state.events.pop_front();
            state.dropped += 1;
            discarded += 1;
        }

        state.events.push_back(event);
        drop(state);
        self.arrived.notify_one();
        discarded
    }

    /// Take everything queued right now.
    pub fn drain(&self) -> Vec<EventEnvelope> {
        let mut state = self.state.lock().expect("event queue mutex");
        state.events.drain(..).collect()
    }

    /// Wait for one observation.
    pub fn next(&self, timeout: Duration) -> Option<EventEnvelope> {
        let deadline = Instant::now() + timeout;
        let mut state = self.state.lock().expect("event queue mutex");

        loop {
            if let Some(event) = state.events.pop_front() {
                return Some(event);
            }
            if state.closed {
                return None;
            }

            let remaining = deadline.checked_duration_since(Instant::now())?;
            let (next, timed_out) = self
                .arrived
                .wait_timeout(state, remaining)
                .expect("event queue condvar");
            state = next;
            if timed_out.timed_out() && state.events.is_empty() {
                return None;
            }
        }
    }

    /// How many observations this queue has discarded, for the whole connection.
    pub fn dropped(&self) -> u64 {
        self.state.lock().expect("event queue mutex").dropped
    }

    pub fn len(&self) -> usize {
        self.state.lock().expect("event queue mutex").events.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// No more events will arrive. Wakes anyone waiting rather than leaving
    /// them to time out.
    pub fn close(&self) {
        let mut state = self.state.lock().expect("event queue mutex");
        state.closed = true;
        drop(state);
        self.arrived.notify_all();
    }
}

impl Default for EventQueue {
    fn default() -> Self {
        Self::new(EVENT_QUEUE_CAPACITY)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hii_rhino_protocol::{EventKind, RhinoInstanceId, RhinoSessionRef, PROTOCOL_VERSION};
    use serde_json::json;
    use uuid::Uuid;

    fn event(id: &str) -> EventEnvelope {
        EventEnvelope {
            protocol_version: PROTOCOL_VERSION,
            event_id: id.to_string(),
            kind: EventKind::ObjectAdded,
            session: RhinoSessionRef {
                rhino_instance_id: RhinoInstanceId(Uuid::from_u128(1)),
                process_id: 1,
                session_id: 1,
                document_runtime_serial: Some(1),
            },
            emitted_at_unix_ms: 0,
            data: json!({}),
            dropped_before: None,
        }
    }

    #[test]
    fn events_come_back_in_the_order_they_were_observed() {
        let queue = EventQueue::new(8);
        for index in 0..3 {
            queue.push(event(&format!("evt-{index}")));
        }

        let ids: Vec<_> = queue.drain().into_iter().map(|e| e.event_id).collect();
        assert_eq!(ids, vec!["evt-0", "evt-1", "evt-2"]);
        assert_eq!(queue.dropped(), 0);
    }

    #[test]
    fn a_full_queue_discards_the_oldest_and_says_so() {
        // The property that matters: pushing never blocks and never fails, so
        // the reader thread cannot be stalled by a consumer that is not
        // draining. What is lost is lost loudly.
        let queue = EventQueue::new(3);
        for index in 0..5 {
            queue.push(event(&format!("evt-{index}")));
        }

        assert_eq!(queue.dropped(), 2);
        let ids: Vec<_> = queue.drain().into_iter().map(|e| e.event_id).collect();
        assert_eq!(ids, vec!["evt-2", "evt-3", "evt-4"]);
    }

    #[test]
    fn a_push_reports_what_it_had_to_discard() {
        let queue = EventQueue::new(2);
        assert_eq!(queue.push(event("a")), 0);
        assert_eq!(queue.push(event("b")), 0);
        assert_eq!(queue.push(event("c")), 1);
    }

    #[test]
    fn waiting_for_an_event_gives_up_rather_than_hanging() {
        let queue = EventQueue::new(4);
        let started = Instant::now();
        assert!(queue.next(Duration::from_millis(150)).is_none());
        assert!(started.elapsed() >= Duration::from_millis(100));
    }

    #[test]
    fn closing_wakes_a_waiter_instead_of_making_it_wait_out_the_timeout() {
        // A connection that has died should not make every event consumer sit
        // through its full timeout before finding out.
        let queue = std::sync::Arc::new(EventQueue::new(4));
        let background = std::sync::Arc::clone(&queue);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            background.close();
        });

        let started = Instant::now();
        assert!(queue.next(Duration::from_secs(10)).is_none());
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "waited {:?}",
            started.elapsed()
        );
    }
}
