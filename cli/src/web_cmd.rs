// SPDX-License-Identifier: LicenseRef-BSL-1.1

//! Runs governed browser intent cases through the local browser worker.

use crate::config::AppPaths;
use hii_core::web::{
    run_least_expensive_available, BrowserCommandV1, BrowserErrorCodeV1, BrowserErrorV1,
    BrowserPortV1, BrowserResultV1, ProtocolRequestV1, ProtocolResponseV1, RequestId,
    WebIntentCaseV1,
};
use serde_json::json;
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
};

pub fn vertical_test(
    paths: &AppPaths,
    url: &str,
    browserd: &Path,
    require_approval: bool,
    approve: bool,
    json_output: bool,
) -> Result<(), String> {
    let mut port = StdioBrowserPort::spawn(browserd)?;
    let case = run_least_expensive_available(&mut port, url, require_approval, approve)
        .map_err(render_browser_error)?;
    let receipt_path = persist_receipt(&paths.runtime, &case)?;
    if json_output {
        println!(
            "{}",
            serde_json::to_string_pretty(&json!({
                "case": case,
                "receiptPath": receipt_path,
            }))
            .map_err(|error| error.to_string())?
        );
    } else {
        println!("intent     {}", case.intent);
        println!("status     {:?}", case.status);
        if let Some(outcome) = &case.outcome {
            println!("outcome    {outcome}");
        }
        if let Some(path) = receipt_path {
            println!("proof      {}", path.display());
        }
    }
    Ok(())
}

struct StdioBrowserPort {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    next_id: u64,
}

impl StdioBrowserPort {
    fn spawn(browserd: &Path) -> Result<Self, String> {
        if !browserd.is_file() {
            return Err(format!("browser worker not found: {}", browserd.display()));
        }
        let mut child = Command::new("node")
            .arg(browserd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|error| format!("could not start browser worker: {error}"))?;
        let input = child
            .stdin
            .take()
            .ok_or("browser worker stdin is unavailable")?;
        let output = child
            .stdout
            .take()
            .ok_or("browser worker stdout is unavailable")?;
        Ok(Self {
            child,
            input,
            output: BufReader::new(output),
            next_id: 0,
        })
    }
}

impl BrowserPortV1 for StdioBrowserPort {
    fn execute(&mut self, command: BrowserCommandV1) -> Result<BrowserResultV1, BrowserErrorV1> {
        self.next_id += 1;
        let request = ProtocolRequestV1 {
            id: RequestId(format!("req_{}", self.next_id)),
            command,
        };
        let encoded = serde_json::to_string(&request).map_err(|error| browser_failure(&error))?;
        writeln!(self.input, "{encoded}").map_err(|error| browser_failure(&error))?;
        self.input
            .flush()
            .map_err(|error| browser_failure(&error))?;
        let mut line = String::new();
        self.output
            .read_line(&mut line)
            .map_err(|error| browser_failure(&error))?;
        if line.is_empty() {
            return Err(browser_failure("browser worker exited without a response"));
        }
        let response: ProtocolResponseV1 =
            serde_json::from_str(&line).map_err(|error| browser_failure(&error))?;
        if !response.ok {
            return Err(response
                .error
                .unwrap_or_else(|| browser_failure("browser worker returned an empty error")));
        }
        response
            .result
            .ok_or_else(|| browser_failure("browser worker returned an empty result"))
    }
}

impl Drop for StdioBrowserPort {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn persist_receipt(runtime: &Path, case: &WebIntentCaseV1) -> Result<Option<PathBuf>, String> {
    let Some(receipt) = &case.receipt else {
        return Ok(None);
    };
    let directory = runtime.join("receipts/web").join(case.id.replace(':', "_"));
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let path = directory.join("receipt.json");
    crate::store::write_json_atomic(&path, receipt)?;
    Ok(Some(path))
}

fn browser_failure(message: impl std::fmt::Display) -> BrowserErrorV1 {
    BrowserErrorV1 {
        code: BrowserErrorCodeV1::BrowserFailure,
        message: message.to_string(),
        current_revision: None,
    }
}

fn render_browser_error(error: BrowserErrorV1) -> String {
    format!(
        "browser intent failed ({:?}): {}",
        error.code, error.message
    )
}
