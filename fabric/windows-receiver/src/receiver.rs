use crate::{
    ComponentHealth, ComponentStatus, Frame, HealthTelemetry, InputEvent, InputSink,
    LatestFrameMailbox, Lifecycle, ReceiverError, ReceiverHealth, ReceiverResult, ReceiverState,
    Renderer, ServiceBridge, ServiceExposure, ServiceRequest, SubmitOutcome,
};

pub struct Receiver<R, I, S> {
    lifecycle: Lifecycle,
    mailbox: LatestFrameMailbox,
    telemetry: HealthTelemetry,
    renderer: R,
    input: I,
    services: S,
}

impl<R, I, S> Receiver<R, I, S>
where
    R: Renderer,
    I: InputSink,
    S: ServiceBridge,
{
    pub fn new(renderer: R, input: I, services: S) -> Self {
        Self {
            lifecycle: Lifecycle::new(),
            mailbox: LatestFrameMailbox::default(),
            telemetry: HealthTelemetry::new(),
            renderer,
            input,
            services,
        }
    }

    pub fn start(&mut self) -> ReceiverResult<()> {
        self.lifecycle.transition(ReceiverState::Starting)?;
        if let Err(error) = self.renderer.start() {
            self.telemetry.record(ComponentHealth::new(
                "renderer",
                ComponentStatus::Failed,
                error.to_string(),
            ))?;
            self.lifecycle.fail(error.to_string())?;
            return Err(error);
        }
        let renderer_health = self.renderer.health();
        let target_state = if renderer_health.status == ComponentStatus::Ready {
            ReceiverState::Ready
        } else {
            ReceiverState::Degraded
        };
        self.telemetry.record(renderer_health)?;
        self.telemetry.record(self.input.health())?;
        self.telemetry.record(self.services.health())?;
        self.lifecycle.transition(target_state)?;
        Ok(())
    }

    pub fn ingest_frame(&self, frame: Frame) -> ReceiverResult<SubmitOutcome> {
        let state = self.lifecycle.snapshot()?.state;
        if !matches!(state, ReceiverState::Ready | ReceiverState::Degraded) {
            return Err(ReceiverError::ComponentFailure {
                component: "frame ingress",
                message: format!("receiver is {state:?}, not ready"),
            });
        }
        self.mailbox.submit(frame)
    }

    pub fn present_latest(&mut self) -> ReceiverResult<Option<u64>> {
        let Some(frame) = self.mailbox.take_latest()? else {
            return Ok(None);
        };
        let sequence = frame.descriptor().sequence;
        if let Err(error) = self.renderer.present(&frame) {
            self.telemetry.record(ComponentHealth::new(
                "renderer",
                ComponentStatus::Failed,
                error.to_string(),
            ))?;
            self.lifecycle.fail(error.to_string())?;
            return Err(error);
        }
        self.telemetry.record(self.renderer.health())?;
        Ok(Some(sequence))
    }

    pub fn inject_input(&mut self, event: &InputEvent) -> ReceiverResult<()> {
        self.ensure_operational("input injection")?;
        let result = self.input.inject(event);
        self.telemetry.record(self.input.health())?;
        result
    }

    pub fn expose_service(&mut self, request: &ServiceRequest) -> ReceiverResult<ServiceExposure> {
        self.ensure_operational("service exposure")?;
        let result = self.services.expose(request);
        self.telemetry.record(self.services.health())?;
        result
    }

    pub fn revoke_service(&mut self, request_id: u64) -> ReceiverResult<()> {
        self.ensure_operational("service revocation")?;
        let result = self.services.revoke(request_id);
        self.telemetry.record(self.services.health())?;
        result
    }

    pub fn health(&self) -> ReceiverResult<ReceiverHealth> {
        self.telemetry
            .snapshot(self.lifecycle.snapshot()?, self.mailbox.snapshot()?)
    }

    pub fn stop(&mut self) -> ReceiverResult<()> {
        let prior_state = self.lifecycle.snapshot()?.state;
        if prior_state == ReceiverState::Stopped {
            return Ok(());
        }
        if prior_state != ReceiverState::Failed {
            self.lifecycle.transition(ReceiverState::Stopping)?;
        }

        let service_result = self.services.stop();
        let renderer_result = self.renderer.stop();
        self.telemetry.record(self.renderer.health())?;
        self.telemetry.record(self.services.health())?;

        if let Err(error) = service_result.and(renderer_result) {
            if prior_state != ReceiverState::Failed {
                self.lifecycle.fail(error.to_string())?;
            }
            return Err(error);
        }

        self.mailbox.reset_session()?;
        self.lifecycle.transition(ReceiverState::Stopped)?;
        Ok(())
    }

    fn ensure_operational(&self, component: &'static str) -> ReceiverResult<()> {
        let state = self.lifecycle.snapshot()?.state;
        if matches!(state, ReceiverState::Ready | ReceiverState::Degraded) {
            Ok(())
        } else {
            Err(ReceiverError::ComponentFailure {
                component,
                message: format!("receiver is {state:?}, not ready"),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        FrameDescriptor, PixelFormat, TimestampClock, UnsupportedInputSink,
        UnsupportedServiceBridge,
    };

    #[derive(Default)]
    struct TestRenderer {
        started: bool,
        fail_on_present: bool,
    }

    impl Renderer for TestRenderer {
        fn backend_name(&self) -> &'static str {
            "test"
        }

        fn start(&mut self) -> ReceiverResult<()> {
            self.started = true;
            Ok(())
        }

        fn present(&mut self, _frame: &Frame) -> ReceiverResult<()> {
            if self.fail_on_present {
                Err(ReceiverError::ComponentFailure {
                    component: "test renderer",
                    message: "present failed".into(),
                })
            } else {
                Ok(())
            }
        }

        fn stop(&mut self) -> ReceiverResult<()> {
            self.started = false;
            Ok(())
        }

        fn health(&self) -> ComponentHealth {
            ComponentHealth::new(
                "renderer",
                if self.started {
                    ComponentStatus::Ready
                } else {
                    ComponentStatus::Stopped
                },
                "test renderer",
            )
        }
    }

    fn frame_for(stream_id: u64, sequence: u64) -> Frame {
        Frame::new(
            FrameDescriptor {
                stream_id,
                sequence,
                width: 1,
                height: 1,
                format: PixelFormat::EncodedH264,
                captured_at_ns: 0,
                timestamp_clock: TimestampClock::SenderMonotonic,
                payload_len: 1,
                planes: vec![],
                color_range: None,
            },
            vec![0],
        )
        .unwrap()
    }

    fn frame(sequence: u64) -> Frame {
        frame_for(1, sequence)
    }

    #[test]
    fn reports_unsupported_components_without_claiming_capability() {
        let mut receiver = Receiver::new(
            TestRenderer::default(),
            UnsupportedInputSink,
            UnsupportedServiceBridge,
        );
        receiver.start().unwrap();
        let health = receiver.health().unwrap();
        assert_eq!(health.lifecycle.state, ReceiverState::Ready);
        assert_eq!(
            health
                .components
                .iter()
                .filter(|component| component.status == ComponentStatus::Unsupported)
                .count(),
            2
        );
    }

    #[test]
    fn presentation_failure_moves_receiver_to_failed() {
        let mut receiver = Receiver::new(
            TestRenderer {
                fail_on_present: true,
                ..TestRenderer::default()
            },
            UnsupportedInputSink,
            UnsupportedServiceBridge,
        );
        receiver.start().unwrap();
        receiver.ingest_frame(frame(1)).unwrap();
        assert!(receiver.present_latest().is_err());
        let health = receiver.health().unwrap();
        assert_eq!(health.lifecycle.state, ReceiverState::Failed);
        assert_eq!(
            health.lifecycle.last_error.as_deref(),
            Some("test renderer failed: present failed")
        );
    }

    #[test]
    fn ingress_requires_ready_receiver() {
        let receiver = Receiver::new(
            TestRenderer::default(),
            UnsupportedInputSink,
            UnsupportedServiceBridge,
        );
        assert!(matches!(
            receiver.ingest_frame(frame(1)),
            Err(ReceiverError::ComponentFailure {
                component: "frame ingress",
                ..
            })
        ));
    }

    #[test]
    fn failed_receiver_can_stop_and_restart_with_a_new_stream() {
        let mut receiver = Receiver::new(
            TestRenderer {
                fail_on_present: true,
                ..TestRenderer::default()
            },
            UnsupportedInputSink,
            UnsupportedServiceBridge,
        );
        receiver.start().unwrap();
        receiver.ingest_frame(frame(100)).unwrap();
        assert!(receiver.present_latest().is_err());
        receiver.stop().unwrap();
        assert_eq!(
            receiver.health().unwrap().lifecycle.state,
            ReceiverState::Stopped
        );

        receiver.renderer.fail_on_present = false;
        receiver.start().unwrap();
        receiver.ingest_frame(frame_for(2, 1)).unwrap();
    }

    #[test]
    fn consequential_interfaces_require_an_operational_receiver() {
        let mut receiver = Receiver::new(
            TestRenderer::default(),
            UnsupportedInputSink,
            UnsupportedServiceBridge,
        );
        assert!(matches!(
            receiver.inject_input(&InputEvent::Text("no".into())),
            Err(ReceiverError::ComponentFailure {
                component: "input injection",
                ..
            })
        ));
    }
}
