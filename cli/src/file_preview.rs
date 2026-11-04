//! Bounded, local file previews shared by attachments and the file browser.
use std::{fs::File, io::Read, path::Path, process::{Command, Stdio}, time::{Duration, Instant}};

pub fn render(path: &Path, rows: usize, columns: usize) -> Result<String, String> {
    let metadata = path.metadata().map_err(|e| e.to_string())?;
    if !metadata.is_file() { return Err("preview requires a regular file".into()); }
    let mut bytes = Vec::new();
    File::open(path).map_err(|e| e.to_string())?.take(256 * 1024).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    let text = if bytes.starts_with(b"%PDF-") {
        pdf_text(path)?
    } else if image::guess_format(&bytes).is_ok() {
        if metadata.len() > 10 * 1024 * 1024 { return Ok("Image preview exceeds 10 MiB limit".into()); }
        let reader = image::ImageReader::open(path).map_err(|e| e.to_string())?.with_guessed_format().map_err(|e| e.to_string())?;
        let image = reader.decode().map_err(|e| e.to_string())?;
        let thumb = image.thumbnail(columns.min(80).max(1) as u32, rows.min(24).max(1) as u32).to_luma8();
        let ramp = b" .:-=+*#%@";
        let mut output = format!("Image {} x {} (ASCII preview)\n", image.width(), image.height());
        for y in 0..thumb.height() {
            for x in 0..thumb.width() { output.push(ramp[thumb.get_pixel(x,y)[0] as usize * 9 / 255] as char); }
            output.push('\n');
        }
        return Ok(output);
    } else {
        if bytes.contains(&0) { return Ok(format!("Binary file · {} bytes", metadata.len())); }
        String::from_utf8_lossy(&bytes).into_owned()
    };
    let mut lines = text.lines().take(rows).map(|line| {
        let safe: String = line.chars().filter(|c| !c.is_control() || *c == '\t').collect();
        crate::text::clip(&safe.replace('\t', "    "), columns)
    }).collect::<Vec<_>>();
    if text.lines().count() > rows || metadata.len() > 256 * 1024 { lines.push("... preview truncated".into()); }
    Ok(lines.join("\n"))
}

fn pdf_text(path: &Path) -> Result<String, String> {
    let temp = tempfile::tempdir().map_err(|e| e.to_string())?;
    let output = temp.path().join("preview.txt");
    let mut child = Command::new("pdftotext").args(["-f", "1", "-l", "2", "-layout"]).arg(path).arg(&output)
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn()
        .map_err(|_| "PDF preview requires pdftotext (Poppler) on this device".to_string())?;
    let start = Instant::now();
    loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            if !status.success() { return Err("PDF text preview failed; document may be encrypted".into()); }
            break;
        }
        if start.elapsed() > Duration::from_secs(3) {
            let _ = child.kill(); let _ = child.wait(); return Err("PDF preview timed out".into());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let mut text = String::new();
    File::open(output).map_err(|e| e.to_string())?.take(256 * 1024).read_to_string(&mut text).map_err(|e| e.to_string())?;
    if text.trim().is_empty() { return Ok("PDF has no extractable text; scanned pages require OCR".into()); }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preview_preserves_indent_and_bounds_text() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("code.rs");
        std::fs::write(&path, "fn main() {\n    hello();\n}\n").unwrap();
        assert_eq!(render(&path, 2, 80).unwrap(), "fn main() {\n    hello();\n... preview truncated");
    }
    #[test]
    fn preview_sanitizes_control_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("log.txt");
        std::fs::write(&path, "hello\x1b[2J").unwrap();
        assert!(!render(&path, 24, 80).unwrap().contains('\x1b'));
    }
    #[test]
    fn image_preview_is_portable_ascii() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("image.png");
        image::GrayImage::new(10, 10).save(&path).unwrap();
        let preview = render(&path, 5, 10).unwrap();
        assert!(preview.contains("10 x 10"));
        assert!(preview.is_ascii());
    }
}
