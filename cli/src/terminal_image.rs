use crate::{attachments::ImagePayload, settings};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use std::{
    env,
    io::{self, Cursor, IsTerminal, Write},
    path::Path,
};

pub fn render(runtime: &Path, image: &ImagePayload) -> Result<bool, String> {
    let preference = settings::load(runtime).inline_images;
    if preference == "off" || !io::stdout().is_terminal() {
        return Ok(false);
    }
    let supported = supports_kitty_graphics();
    if preference == "auto" && !supported {
        return Ok(false);
    }
    if preference == "on" && !supported {
        return Err("inline images are enabled, but this terminal does not advertise Kitty graphics support".into());
    }
    let encoded = if image.mime_type == "image/png" {
        image.base64.clone()
    } else {
        let bytes = STANDARD.decode(&image.base64).map_err(|e| e.to_string())?;
        let decoded = image::load_from_memory(&bytes).map_err(|e| e.to_string())?;
        let mut png = Cursor::new(Vec::new());
        decoded
            .write_to(&mut png, image::ImageFormat::Png)
            .map_err(|e| e.to_string())?;
        STANDARD.encode(png.into_inner())
    };
    let chunks = encoded.as_bytes().chunks(4096).collect::<Vec<_>>();
    let mut out = io::stdout().lock();
    for (index, chunk) in chunks.iter().enumerate() {
        let more = usize::from(index + 1 < chunks.len());
        let header = if index == 0 {
            format!("\x1b_Ga=T,f=100,q=2,m={more};")
        } else {
            format!("\x1b_Gm={more};")
        };
        out.write_all(header.as_bytes())
            .map_err(|e| e.to_string())?;
        out.write_all(chunk).map_err(|e| e.to_string())?;
        out.write_all(b"\x1b\\").map_err(|e| e.to_string())?;
    }
    out.write_all(b"\n").map_err(|e| e.to_string())?;
    out.flush().map_err(|e| e.to_string())?;
    Ok(true)
}

fn supports_kitty_graphics() -> bool {
    env::var("TERM_PROGRAM")
        .is_ok_and(|v| matches!(v.to_ascii_lowercase().as_str(), "ghostty" | "wezterm"))
        || env::var("TERM").is_ok_and(|v| v.to_ascii_lowercase().contains("kitty"))
}
