use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};

use crate::{Frame, ReceiverError, ReceiverResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubmitOutcome {
    Stored,
    ReplacedOlder,
    RejectedStale,
    RejectedWrongStream,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MailboxSnapshot {
    pub active_stream_id: Option<u64>,
    pub pending_sequence: Option<u64>,
    pub accepted: u64,
    pub dropped: u64,
    pub rejected_stale: u64,
    pub rejected_wrong_stream: u64,
    pub taken: u64,
}

#[derive(Debug, Default)]
struct MailboxState {
    pending: Option<Frame>,
    active_stream_id: Option<u64>,
    last_sequence: Option<u64>,
}

#[derive(Debug, Default)]
pub struct LatestFrameMailbox {
    state: Mutex<MailboxState>,
    accepted: AtomicU64,
    dropped: AtomicU64,
    rejected_stale: AtomicU64,
    rejected_wrong_stream: AtomicU64,
    taken: AtomicU64,
}

impl LatestFrameMailbox {
    pub fn submit(&self, frame: Frame) -> ReceiverResult<SubmitOutcome> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| ReceiverError::StatePoisoned("latest-frame mailbox"))?;
        let descriptor = frame.descriptor();
        if state
            .active_stream_id
            .is_some_and(|stream_id| stream_id != descriptor.stream_id)
        {
            self.rejected_wrong_stream.fetch_add(1, Ordering::Relaxed);
            return Ok(SubmitOutcome::RejectedWrongStream);
        }
        if state
            .last_sequence
            .is_some_and(|sequence| sequence >= descriptor.sequence)
        {
            self.rejected_stale.fetch_add(1, Ordering::Relaxed);
            return Ok(SubmitOutcome::RejectedStale);
        }

        state.active_stream_id = Some(descriptor.stream_id);
        state.last_sequence = Some(descriptor.sequence);
        let outcome = if state.pending.replace(frame).is_some() {
            self.dropped.fetch_add(1, Ordering::Relaxed);
            SubmitOutcome::ReplacedOlder
        } else {
            SubmitOutcome::Stored
        };
        self.accepted.fetch_add(1, Ordering::Relaxed);
        Ok(outcome)
    }

    pub fn take_latest(&self) -> ReceiverResult<Option<Frame>> {
        let frame = self
            .state
            .lock()
            .map_err(|_| ReceiverError::StatePoisoned("latest-frame mailbox"))?
            .pending
            .take();
        if frame.is_some() {
            self.taken.fetch_add(1, Ordering::Relaxed);
        }
        Ok(frame)
    }

    /// Clear the active stream binding only after authenticated channel/session
    /// teardown. Incoming stream IDs must never trigger this reset.
    pub fn reset_session(&self) -> ReceiverResult<()> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| ReceiverError::StatePoisoned("latest-frame mailbox"))?;
        if state.pending.take().is_some() {
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
        state.active_stream_id = None;
        state.last_sequence = None;
        Ok(())
    }

    pub fn snapshot(&self) -> ReceiverResult<MailboxSnapshot> {
        let state = self
            .state
            .lock()
            .map_err(|_| ReceiverError::StatePoisoned("latest-frame mailbox"))?;
        let pending_sequence = state
            .pending
            .as_ref()
            .map(|frame| frame.descriptor().sequence);
        Ok(MailboxSnapshot {
            active_stream_id: state.active_stream_id,
            pending_sequence,
            accepted: self.accepted.load(Ordering::Relaxed),
            dropped: self.dropped.load(Ordering::Relaxed),
            rejected_stale: self.rejected_stale.load(Ordering::Relaxed),
            rejected_wrong_stream: self.rejected_wrong_stream.load(Ordering::Relaxed),
            taken: self.taken.load(Ordering::Relaxed),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{FrameDescriptor, PixelFormat, TimestampClock};

    fn frame(stream_id: u64, sequence: u64) -> Frame {
        Frame::new(
            FrameDescriptor {
                stream_id,
                sequence,
                width: 1,
                height: 1,
                format: PixelFormat::EncodedH264,
                captured_at_ns: sequence,
                timestamp_clock: TimestampClock::SenderMonotonic,
                payload_len: 1,
                planes: vec![],
                color_range: None,
            },
            vec![sequence as u8],
        )
        .unwrap()
    }

    #[test]
    fn replaces_pending_frame_and_counts_drop() {
        let mailbox = LatestFrameMailbox::default();
        assert_eq!(mailbox.submit(frame(1, 1)).unwrap(), SubmitOutcome::Stored);
        assert_eq!(
            mailbox.submit(frame(1, 2)).unwrap(),
            SubmitOutcome::ReplacedOlder
        );
        assert_eq!(
            mailbox
                .take_latest()
                .unwrap()
                .unwrap()
                .descriptor()
                .sequence,
            2
        );
        assert_eq!(
            mailbox.snapshot().unwrap(),
            MailboxSnapshot {
                active_stream_id: Some(1),
                pending_sequence: None,
                accepted: 2,
                dropped: 1,
                rejected_stale: 0,
                rejected_wrong_stream: 0,
                taken: 1,
            }
        );
    }

    #[test]
    fn rejects_stale_frame_for_same_stream() {
        let mailbox = LatestFrameMailbox::default();
        mailbox.submit(frame(1, 2)).unwrap();
        mailbox.take_latest().unwrap();
        assert_eq!(
            mailbox.submit(frame(1, 1)).unwrap(),
            SubmitOutcome::RejectedStale
        );
        assert_eq!(mailbox.snapshot().unwrap().rejected_stale, 1);
    }

    #[test]
    fn rejects_frames_from_another_stream() {
        let mailbox = LatestFrameMailbox::default();
        mailbox.submit(frame(1, 100)).unwrap();
        assert_eq!(
            mailbox.submit(frame(2, 1)).unwrap(),
            SubmitOutcome::RejectedWrongStream
        );
        assert_eq!(mailbox.snapshot().unwrap().rejected_wrong_stream, 1);
    }

    #[test]
    fn cross_stream_frame_cannot_erase_sequence_high_water_mark() {
        let mailbox = LatestFrameMailbox::default();
        mailbox.submit(frame(1, 100)).unwrap();
        assert_eq!(
            mailbox.submit(frame(2, 1)).unwrap(),
            SubmitOutcome::RejectedWrongStream
        );
        assert_eq!(
            mailbox.submit(frame(1, 99)).unwrap(),
            SubmitOutcome::RejectedStale
        );
        assert_eq!(mailbox.snapshot().unwrap().pending_sequence, Some(100));
    }

    #[test]
    fn authenticated_teardown_reset_allows_a_new_stream() {
        let mailbox = LatestFrameMailbox::default();
        mailbox.submit(frame(1, 100)).unwrap();
        mailbox.reset_session().unwrap();
        assert_eq!(mailbox.submit(frame(2, 1)).unwrap(), SubmitOutcome::Stored);
        assert_eq!(mailbox.snapshot().unwrap().active_stream_id, Some(2));
    }
}
