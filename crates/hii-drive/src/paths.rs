use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

// This local prototype rejects symlink traversal instead of treating links as
// authority to operate on another tree. A future remote executor also needs
// handle-relative operations to defend against concurrent link replacement.
pub(crate) fn beneath(root: &Path, relative: &Path) -> io::Result<PathBuf> {
    if relative.as_os_str().is_empty()
        || relative
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
        || relative.to_string_lossy().contains(['\\', ':'])
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Expected a relative path inside the Drive",
        ));
    }
    reject_link(root)?;
    let mut target = root.to_path_buf();
    for part in relative.components() {
        target.push(part.as_os_str());
        reject_link(&target)?;
    }
    Ok(target)
}

pub(crate) fn reject_link(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Drive paths must not traverse symbolic links",
        )),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}
