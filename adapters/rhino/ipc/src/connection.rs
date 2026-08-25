//! Opening a connection to a bridge.
//!
//! The client above this layer is transport-agnostic on purpose: it needs a
//! readable half and a writable half and nothing else. That keeps the named
//! pipe out of the demultiplexing logic (which is where the hard behaviour
//! lives and where tests need to run without Rhino), and leaves room for the
//! Unix-domain-socket variant macOS will want.
//!
//! # Why this is overlapped I/O and not `std::fs::File`
//!
//! The obvious implementation — open the pipe as a `File`, `try_clone()` it,
//! read on one and write on the other — does not work, and fails in a way that
//! looks like a bug somewhere else entirely. A handle opened without
//! `FILE_FLAG_OVERLAPPED` is a *synchronous* handle, and Windows serialises
//! every operation on it. `try_clone` is `DuplicateHandle`, which produces a
//! second handle to the same file object and therefore the same queue. So once
//! the reader thread has a `ReadFile` pending, every write blocks behind it
//! until a message happens to arrive.
//!
//! Measured before this was rewritten: a request write blocked for 87 seconds
//! and then failed with `ERROR_NO_DATA` when the peer was killed. The handshake
//! write had succeeded only because it won a race against the reader thread
//! issuing its first read.
//!
//! Overlapped I/O is therefore not an optimisation here; it is the only shape
//! that works. It also buys the thing a synchronous handle could never offer:
//! a read that can actually be cancelled, which is what lets a request impose a
//! real deadline and what checkpoint D's cancellation story rests on.
//!
//! `pipe_serialisation_regression` pins this. If it fails, someone has gone
//! back to a synchronous handle.

use hii_rhino_protocol::{transport::Advertisement, ErrorCode, ErrorEnvelope};
use std::{
    io::{self, Read, Write},
    time::Duration,
};

/// A bidirectional byte stream that can be split into independently owned
/// halves, so a reader thread can block on one while the caller writes to the
/// other.
pub trait Duplex {
    fn split(self) -> io::Result<(Box<dyn Read + Send>, Box<dyn Write + Send>)>;
}

/// Available so the client's real behaviour — demultiplexing, deadlines, loss —
/// can be tested over loopback on any platform. Not used in production: the
/// bridge is local-only and never listens on a socket.
impl Duplex for std::net::TcpStream {
    fn split(self) -> io::Result<(Box<dyn Read + Send>, Box<dyn Write + Send>)> {
        let writer = self.try_clone()?;
        Ok((Box::new(self), Box::new(writer)))
    }
}

/// How long to wait for a pipe that exists but has no free instance.
const BUSY_RETRY_WINDOW: Duration = Duration::from_millis(750);

/// How long a single write may take before the connection is judged wedged.
/// A write only blocks if the peer has stopped draining the pipe.
const WRITE_TIMEOUT: Duration = Duration::from_secs(30);

#[cfg(windows)]
pub use windows::{Canceller, PipeConnection, PipeReader, PipeWriter};

#[cfg(windows)]
mod windows {
    use super::*;
    use std::{os::windows::ffi::OsStrExt, ptr, sync::Arc};
    use windows_sys::Win32::{
        Foundation::{
            CloseHandle, GetLastError, ERROR_BROKEN_PIPE, ERROR_HANDLE_EOF, ERROR_IO_PENDING,
            ERROR_OPERATION_ABORTED, ERROR_PIPE_BUSY, ERROR_PIPE_NOT_CONNECTED, HANDLE,
            INVALID_HANDLE_VALUE, WAIT_OBJECT_0, WAIT_TIMEOUT,
        },
        Storage::FileSystem::{CreateFileW, ReadFile, WriteFile, FILE_FLAG_OVERLAPPED},
        System::{
            Pipes::{GetNamedPipeServerProcessId, WaitNamedPipeW},
            Threading::{CreateEventW, ResetEvent, WaitForSingleObject, INFINITE},
            IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED},
        },
    };

    // Spelled out rather than imported: these are stable Win32 values, and
    // pinning them here keeps the module from breaking on a `windows-sys`
    // reshuffle of where a constant lives.
    const GENERIC_READ: u32 = 0x8000_0000;
    const GENERIC_WRITE: u32 = 0x4000_0000;
    const OPEN_EXISTING: u32 = 3;

    /// An owned Win32 handle.
    struct OwnedHandle(HANDLE);

    // The handle is opened overlapped, so it is genuinely usable from several
    // threads at once — that is the entire point of this module.
    unsafe impl Send for OwnedHandle {}
    unsafe impl Sync for OwnedHandle {}

    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    fn last_error() -> u32 {
        unsafe { GetLastError() }
    }

    fn create_event() -> io::Result<OwnedHandle> {
        // Manual reset, initially unsignalled. Each direction gets its own:
        // sharing one event between a pending read and a pending write is the
        // serialisation bug again, wearing a different hat.
        let handle = unsafe { CreateEventW(ptr::null(), 1, 0, ptr::null()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        Ok(OwnedHandle(handle))
    }

    fn wide(text: &str) -> Vec<u16> {
        std::ffi::OsStr::new(text)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    /// Run one overlapped operation to completion, or cancel it.
    ///
    /// # Safety
    ///
    /// `start` must issue exactly one overlapped operation against `handle`
    /// using the `OVERLAPPED` it is handed, and any buffer it passes must stay
    /// valid until this function returns — which it does, because a timed-out
    /// operation is cancelled *and reaped* before returning. Skipping the reap
    /// would leave the kernel writing into a freed buffer.
    unsafe fn run_overlapped(
        handle: HANDLE,
        event: HANDLE,
        timeout: Option<Duration>,
        start: impl FnOnce(*mut OVERLAPPED) -> i32,
    ) -> io::Result<u32> {
        ResetEvent(event);

        let mut overlapped: OVERLAPPED = std::mem::zeroed();
        overlapped.hEvent = event;

        let started = start(&mut overlapped);
        if started == 0 {
            let error = last_error();
            if error != ERROR_IO_PENDING {
                return Err(io::Error::from_raw_os_error(error as i32));
            }
        }

        let milliseconds = match timeout {
            Some(timeout) => timeout.as_millis().min(u32::MAX as u128 - 1) as u32,
            None => INFINITE,
        };

        let waited = WaitForSingleObject(event, milliseconds);
        let mut transferred: u32 = 0;

        if waited == WAIT_TIMEOUT {
            CancelIoEx(handle, &overlapped);
            // Reap unconditionally, and only then let `overlapped` and the
            // caller's buffer go out of scope. This is the one place in the
            // crate where getting the order wrong is memory-unsafe rather than
            // merely incorrect.
            GetOverlappedResult(handle, &overlapped, &mut transferred, 1);
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "the pipe operation did not complete in time",
            ));
        }
        if waited != WAIT_OBJECT_0 {
            let error = io::Error::last_os_error();
            CancelIoEx(handle, &overlapped);
            GetOverlappedResult(handle, &overlapped, &mut transferred, 1);
            return Err(error);
        }

        if GetOverlappedResult(handle, &overlapped, &mut transferred, 1) == 0 {
            return Err(io::Error::from_raw_os_error(last_error() as i32));
        }
        Ok(transferred)
    }

    /// Errors that mean "the peer is gone", as opposed to a real fault. A user
    /// quitting Rhino must not read as corruption.
    fn is_clean_end(error: &io::Error) -> bool {
        matches!(
            error.raw_os_error().map(|code| code as u32),
            Some(ERROR_BROKEN_PIPE)
                | Some(ERROR_PIPE_NOT_CONNECTED)
                | Some(ERROR_HANDLE_EOF)
                | Some(ERROR_OPERATION_ABORTED)
        )
    }

    /// A live overlapped connection to a bridge's pipe.
    pub struct PipeConnection {
        handle: Arc<OwnedHandle>,
    }

    /// Unblocks a reader parked in a pending read, from another thread.
    ///
    /// Without this a client that is dropped while Rhino is idle would leave
    /// its reader thread parked until Rhino exits.
    #[derive(Clone)]
    pub struct Canceller {
        handle: Arc<OwnedHandle>,
    }

    impl Canceller {
        pub fn cancel(&self) {
            // A null `OVERLAPPED` cancels every operation this process has
            // outstanding on the handle.
            unsafe {
                CancelIoEx(self.handle.0, ptr::null());
            }
        }
    }

    impl PipeConnection {
        /// Open the pipe an advertisement points at.
        ///
        /// A stale advertisement — Rhino crashed, the file outlived it —
        /// surfaces as `BridgeUnavailable`, which is the caller's cue to prune
        /// it rather than to report a fault.
        pub fn open(advertisement: &Advertisement) -> Result<Self, ErrorEnvelope> {
            let path = advertisement.pipe_path();
            let wide_path = wide(&path);

            let unavailable = |detail: String| {
                ErrorEnvelope::new(
                    None,
                    ErrorCode::BridgeUnavailable,
                    format!("could not open {path}: {detail}"),
                )
            };

            loop {
                let handle = unsafe {
                    CreateFileW(
                        wide_path.as_ptr(),
                        GENERIC_READ | GENERIC_WRITE,
                        0,
                        ptr::null(),
                        OPEN_EXISTING,
                        FILE_FLAG_OVERLAPPED,
                        ptr::null_mut(),
                    )
                };
                if handle != INVALID_HANDLE_VALUE && !handle.is_null() {
                    return Ok(Self {
                        handle: Arc::new(OwnedHandle(handle)),
                    });
                }

                let error = last_error();
                if error != ERROR_PIPE_BUSY {
                    return Err(unavailable(
                        io::Error::from_raw_os_error(error as i32).to_string(),
                    ));
                }

                // Every server instance is in use. The pipe is there; waiting
                // is the correct answer, and `WaitNamedPipeW` waits on the
                // pipe itself instead of guessing with a sleep.
                let waited = unsafe {
                    WaitNamedPipeW(wide_path.as_ptr(), BUSY_RETRY_WINDOW.as_millis() as u32)
                };
                if waited == 0 {
                    return Err(unavailable(
                        "every pipe instance is busy and none freed up".to_string(),
                    ));
                }
            }
        }

        /// The process id of whoever is serving this pipe.
        ///
        /// Asked of the kernel, on the handle we already hold, so a process
        /// squatting the pipe name cannot answer it dishonestly the way it
        /// could answer a handshake.
        pub fn server_process_id(&self) -> io::Result<u32> {
            let mut process_id: u32 = 0;
            let ok = unsafe { GetNamedPipeServerProcessId(self.handle.0, &mut process_id) };
            if ok == 0 {
                return Err(io::Error::from_raw_os_error(last_error() as i32));
            }
            Ok(process_id)
        }

        pub fn canceller(&self) -> Canceller {
            Canceller {
                handle: Arc::clone(&self.handle),
            }
        }

        /// Split into concrete halves, optionally giving reads a deadline.
        ///
        /// The demultiplexing client wants `None` — it parks until a message
        /// arrives and relies on `Canceller` to be woken. A deadline is
        /// available because a timed-out read has to be *provably* survivable:
        /// see `a_timed_out_read_leaves_the_connection_usable`.
        pub fn split_typed(
            self,
            read_timeout: Option<Duration>,
        ) -> io::Result<(PipeReader, PipeWriter)> {
            let reader = PipeReader {
                handle: Arc::clone(&self.handle),
                event: create_event()?,
                timeout: read_timeout,
            };
            let writer = PipeWriter {
                handle: self.handle,
                event: create_event()?,
                timeout: Some(WRITE_TIMEOUT),
            };
            Ok((reader, writer))
        }
    }

    impl Duplex for PipeConnection {
        fn split(self) -> io::Result<(Box<dyn Read + Send>, Box<dyn Write + Send>)> {
            let (reader, writer) = self.split_typed(None)?;
            Ok((Box::new(reader), Box::new(writer)))
        }
    }

    pub struct PipeReader {
        handle: Arc<OwnedHandle>,
        event: OwnedHandle,
        /// `None` blocks until a message arrives or the read is cancelled,
        /// which is what the demultiplexing reader thread wants: per-request
        /// deadlines are enforced by the caller, not by tearing the stream
        /// down under it.
        timeout: Option<Duration>,
    }

    impl Read for PipeReader {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            if buffer.is_empty() {
                return Ok(0);
            }
            let handle = self.handle.0;
            let event = self.event.0;
            let length = buffer.len().min(u32::MAX as usize) as u32;
            let pointer = buffer.as_mut_ptr();

            let result = unsafe {
                run_overlapped(handle, event, self.timeout, |overlapped| {
                    ReadFile(handle, pointer, length, ptr::null_mut(), overlapped)
                })
            };
            match result {
                Ok(read) => Ok(read as usize),
                // Reported as end-of-stream so the framing layer can tell a
                // clean close from a truncated frame.
                Err(error) if is_clean_end(&error) => Ok(0),
                Err(error) => Err(error),
            }
        }
    }

    pub struct PipeWriter {
        handle: Arc<OwnedHandle>,
        event: OwnedHandle,
        timeout: Option<Duration>,
    }

    impl Write for PipeWriter {
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
            if buffer.is_empty() {
                return Ok(0);
            }
            let handle = self.handle.0;
            let event = self.event.0;
            let length = buffer.len().min(u32::MAX as usize) as u32;
            let pointer = buffer.as_ptr();

            let written = unsafe {
                run_overlapped(handle, event, self.timeout, |overlapped| {
                    WriteFile(handle, pointer, length, ptr::null_mut(), overlapped)
                })
            }?;
            Ok(written as usize)
        }

        fn flush(&mut self) -> io::Result<()> {
            // Every write is a completed kernel operation; there is no
            // user-space buffer to push.
            Ok(())
        }
    }
}

/// Open the pipe an advertisement points at, ready to be split.
///
/// The pipe's server process is checked against the advertisement before the
/// connection is handed back. It is cheap — one kernel call on the handle we
/// just opened — and it is the only check that runs *before* a single byte is
/// written, so a process squatting the pipe name never sees our handshake at
/// all. The handshake's instance-id comparison still runs afterwards and is not
/// weakened by this: the two catch different things, and this one catches a
/// name taken over by something that is not a Rhino bridge at all.
#[cfg(windows)]
pub fn open_pipe(advertisement: &Advertisement) -> Result<PipeConnection, ErrorEnvelope> {
    let connection = PipeConnection::open(advertisement)?;

    match connection.server_process_id() {
        Ok(actual) if actual == advertisement.process_id => Ok(connection),
        Ok(actual) => Err(ErrorEnvelope::new(
            None,
            // Deliberately not `BridgeUnavailable`. That code is the facade's
            // cue to delete the advertisement, and deleting a file because a
            // squatter answered would let whoever squats a pipe name evict real
            // bridges from discovery.
            ErrorCode::RhinoInstanceNotFound,
            format!(
                "pipe {} is served by process {actual}, but its advertisement claims process {}",
                advertisement.pipe_name, advertisement.process_id
            ),
        )),
        Err(error) => Err(ErrorEnvelope::new(
            None,
            ErrorCode::BridgeUnavailable,
            format!(
                "could not confirm which process serves {}: {error}",
                advertisement.pipe_name
            ),
        )),
    }
}

#[cfg(not(windows))]
pub struct PipeConnection;

#[cfg(not(windows))]
#[derive(Clone)]
pub struct Canceller;

#[cfg(not(windows))]
impl Canceller {
    pub fn cancel(&self) {}
}

#[cfg(not(windows))]
impl PipeConnection {
    pub fn canceller(&self) -> Canceller {
        Canceller
    }
}

#[cfg(not(windows))]
impl Duplex for PipeConnection {
    fn split(self) -> io::Result<(Box<dyn Read + Send>, Box<dyn Write + Send>)> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "the HII Rhino bridge transport is Windows-only in this build",
        ))
    }
}

#[cfg(not(windows))]
pub fn open_pipe(advertisement: &Advertisement) -> Result<PipeConnection, ErrorEnvelope> {
    let _ = (advertisement, BUSY_RETRY_WINDOW, WRITE_TIMEOUT);
    Err(ErrorEnvelope::new(
        None,
        ErrorCode::BridgeUnavailable,
        "the HII Rhino bridge transport is Windows-only in this build",
    ))
}
