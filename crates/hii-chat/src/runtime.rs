// SPDX-License-Identifier: LicenseRef-BSL-1.1
use crate::{
    files::AppFiles,
    model::Settings,
    provider::{local_endpoint, validate_settings, InferenceProvider, ModelInfo, OpenAiCompatible},
};
use anyhow::{anyhow, ensure, Context, Result};
use serde::Serialize;
use std::{
    io::Read,
    path::Path,
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
};

#[derive(Clone, Debug, Serialize)]
pub struct RuntimeStatus {
    pub state: String,
    pub owned: bool,
    pub models: Vec<ModelInfo>,
    pub error: Option<String>,
}

struct ManagedChild {
    child: Child,
    #[cfg(windows)]
    _job: windows_job::Job,
}

impl Drop for ManagedChild {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub struct RuntimeManager {
    files: Arc<AppFiles>,
    process: Mutex<Option<ManagedChild>>,
}

impl RuntimeManager {
    pub fn new(files: Arc<AppFiles>) -> Self {
        Self {
            files,
            process: Mutex::new(None),
        }
    }

    pub fn owned(&self) -> bool {
        self.process.lock().map(|p| p.is_some()).unwrap_or(true)
    }

    pub fn start(&self, settings: &Settings) -> Result<()> {
        validate_settings(settings)?;
        ensure!(settings.managed, "Select managed llama.cpp mode first");
        ensure!(
            !settings.model.trim().is_empty(),
            "Set a model name before starting llama.cpp"
        );
        let mut process = self
            .process
            .lock()
            .map_err(|_| anyhow!("Runtime lock poisoned"))?;
        if let Some(running) = process.as_mut() {
            if running.child.try_wait()?.is_none() {
                return Ok(());
            }
            *process = None;
        }
        let base = local_endpoint(&settings.endpoint)?;
        ensure!(
            base.path() == "/v1/",
            "Managed llama.cpp requires a /v1 endpoint"
        );
        let host = base
            .host_str()
            .unwrap()
            .trim_start_matches('[')
            .trim_end_matches(']');
        let address: std::net::IpAddr = host.parse()?;
        let port = base.port_or_known_default().unwrap();
        // Refuse to attach ownership to a process we did not spawn.
        let probe = std::net::TcpListener::bind((address, port))
            .context("Runtime port is already in use; choose external mode or another port")?;
        let executable = Path::new(&settings.executable);
        let model = Path::new(&settings.model_path);
        ensure!(
            executable.is_absolute() && executable.is_file(),
            "Choose an absolute llama-server executable path"
        );
        ensure!(
            executable.file_stem().and_then(|s| s.to_str()) == Some("llama-server"),
            "Executable must be named llama-server"
        );
        ensure!(
            model.is_absolute() && model.is_file(),
            "Choose an existing absolute GGUF path"
        );
        let mut magic = [0; 4];
        std::fs::File::open(model)?.read_exact(&mut magic)?;
        ensure!(&magic == b"GGUF", "Model file is not a GGUF");
        let log = self.files.runtime_log()?;
        let mut command = Command::new(executable);
        command
            .args([
                "--model",
                &settings.model_path,
                "--host",
                host,
                "--port",
                &port.to_string(),
                "--ctx-size",
                &settings.context_size.to_string(),
                "--n-gpu-layers",
                "auto",
                "--parallel",
                "1",
                "--alias",
                &settings.model,
                "--no-webui",
                "--log-disable",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::from(log.try_clone()?))
            .stderr(Stdio::from(log));
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        drop(probe);
        let mut child = command.spawn().context("Unable to start llama-server")?;
        #[cfg(windows)]
        let job = match windows_job::Job::attach(&child) {
            Ok(job) => job,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };
        *process = Some(ManagedChild {
            child,
            #[cfg(windows)]
            _job: job,
        });
        Ok(())
    }

    pub fn stop(&self) -> Result<()> {
        let mut process = self
            .process
            .lock()
            .map_err(|_| anyhow!("Runtime lock poisoned"))?;
        if let Some(mut owned) = process.take() {
            if owned.child.try_wait()?.is_none() {
                owned.child.kill()?;
                owned.child.wait()?;
            }
        }
        Ok(())
    }

    pub async fn status(&self, settings: &Settings) -> RuntimeStatus {
        let process_state = (|| -> Result<(bool, Option<String>)> {
            let mut process = self
                .process
                .lock()
                .map_err(|_| anyhow!("Runtime lock poisoned"))?;
            if let Some(running) = process.as_mut() {
                if let Some(exit) = running.child.try_wait()? {
                    *process = None;
                    return Ok((false, Some(format!("llama-server exited ({exit})"))));
                }
                return Ok((true, None));
            }
            Ok((false, None))
        })();
        let (owned, error) = process_state.unwrap_or_else(|e| (false, Some(e.to_string())));
        if error.is_some() {
            return RuntimeStatus {
                state: "error".into(),
                owned,
                models: vec![],
                error,
            };
        }
        let result = match OpenAiCompatible::new(&settings.endpoint) {
            Ok(p) => p.models().await,
            Err(e) => Err(e),
        };
        match result {
            Ok(models) if !models.is_empty() => RuntimeStatus {
                state: "ready".into(),
                owned,
                models,
                error: None,
            },
            Ok(_) => RuntimeStatus {
                state: "loading".into(),
                owned,
                models: vec![],
                error: None,
            },
            Err(error) => RuntimeStatus {
                state: if owned { "loading" } else { "offline" }.into(),
                owned,
                models: vec![],
                error: Some(error.to_string()),
            },
        }
    }
}

#[cfg(windows)]
mod windows_job {
    use anyhow::{Context, Result};
    use std::{
        mem::{size_of, zeroed},
        os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
        process::Child,
    };
    use windows_sys::Win32::System::JobObjects::*;

    pub struct Job {
        _handle: OwnedHandle,
    }

    impl Job {
        pub fn attach(child: &Child) -> Result<Self> {
            // Closing the app's job handle also terminates its runtime after a crash.
            unsafe {
                let raw = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if raw.is_null() {
                    return Err(std::io::Error::last_os_error()).context("Create runtime job");
                }
                let handle = OwnedHandle::from_raw_handle(raw);
                let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                if SetInformationJobObject(
                    raw,
                    JobObjectExtendedLimitInformation,
                    &limits as *const _ as *const _,
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                ) == 0
                {
                    return Err(std::io::Error::last_os_error()).context("Configure runtime job");
                }
                if AssignProcessToJobObject(raw, child.as_raw_handle()) == 0 {
                    return Err(std::io::Error::last_os_error())
                        .context("Attach runtime to app lifecycle");
                }
                Ok(Self { _handle: handle })
            }
        }
    }
}
