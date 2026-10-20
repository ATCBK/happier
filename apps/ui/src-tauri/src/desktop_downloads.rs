use std::{collections::HashMap, fs::File, io::Write, path::Path, sync::Mutex};

struct DownloadFile {
    file: Option<File>,
    // The OS handler can keep reading after openPath resolves. The app owns the
    // temp directory until shutdown; failed/canceled transfers remove it early.
    _directory: tempfile::TempDir,
}

#[derive(Default)]
pub struct DesktopDownloadsState(Mutex<HashMap<String, DownloadFile>>);

impl DesktopDownloadsState {
    fn create(&self, root: &Path, name: &str) -> Result<String, String> {
        if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\', '\0']) {
            return Err("Invalid download filename".into());
        }
        std::fs::create_dir_all(root).map_err(|error| error.to_string())?;
        let directory = tempfile::Builder::new()
            .prefix("file-")
            .tempdir_in(root)
            .map_err(|error| error.to_string())?;
        let path = directory.path().join(name);
        let file = File::create_new(&path).map_err(|error| error.to_string())?;
        let path = path
            .to_str()
            .ok_or("Download path is not UTF-8")?
            .to_owned();
        self.0.lock().map_err(|error| error.to_string())?.insert(
            path.clone(),
            DownloadFile {
                file: Some(file),
                _directory: directory,
            },
        );
        Ok(path)
    }

    fn write(&self, path: &str, bytes: &[u8]) -> Result<(), String> {
        self.0
            .lock()
            .map_err(|error| error.to_string())?
            .get_mut(path)
            .ok_or("Download file is not owned by this app")?
            .file
            .as_mut()
            .ok_or("Download file is closed")?
            .write_all(bytes)
            .map_err(|error| error.to_string())
    }

    fn close(&self, path: &str) -> Result<(), String> {
        let mut files = self.0.lock().map_err(|error| error.to_string())?;
        let download = files
            .get_mut(path)
            .ok_or("Download file is not owned by this app")?;
        if let Some(file) = download.file.as_mut() {
            file.flush().map_err(|error| error.to_string())?;
        }
        drop(download.file.take());
        Ok(())
    }

    fn remove(&self, path: &str) -> Result<(), String> {
        let mut files = self.0.lock().map_err(|error| error.to_string())?;
        if let Some(download) = files.get_mut(path) {
            drop(download.file.take());
            // TempDir::close consumes custody even on failure. Keep the guard
            // until removal succeeds so a reported failure remains retryable.
            std::fs::remove_dir_all(download._directory.path())
                .map_err(|error| error.to_string())?;
        }
        files.remove(path);
        Ok(())
    }
}

#[cfg(desktop)]
#[tauri::command]
pub async fn desktop_download_cache_create(
    state: tauri::State<'_, DesktopDownloadsState>,
    name: String,
) -> Result<String, String> {
    state.create(&std::env::temp_dir().join("happier-downloads"), &name)
}

#[cfg(desktop)]
#[tauri::command]
pub async fn desktop_download_cache_write(
    state: tauri::State<'_, DesktopDownloadsState>,
    path: String,
    bytes: Vec<u8>,
) -> Result<(), String> {
    state.write(&path, &bytes)
}

#[cfg(desktop)]
#[tauri::command]
pub async fn desktop_download_cache_close(
    state: tauri::State<'_, DesktopDownloadsState>,
    path: String,
) -> Result<(), String> {
    state.close(&path)
}

#[cfg(desktop)]
#[tauri::command]
pub async fn desktop_download_cache_remove(
    state: tauri::State<'_, DesktopDownloadsState>,
    path: String,
) -> Result<(), String> {
    state.remove(&path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn streams_only_owned_files_and_removes_them_on_cleanup_or_shutdown() {
        let root = tempfile::tempdir().unwrap();
        let state = DesktopDownloadsState::default();
        let path = state.create(root.path(), "report.pdf").unwrap();
        assert!(Path::new(&path).starts_with(root.path()));
        state.write(&path, &[0, 255]).unwrap();
        state.write(&path, &[42]).unwrap();
        state.close(&path).unwrap();
        assert!(state.write(&path, &[12]).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), [0, 255, 42]);
        assert!(state
            .write(root.path().join("other.pdf").to_str().unwrap(), &[1])
            .is_err());
        assert!(state.create(root.path(), "../escape.pdf").is_err());
        assert!(state.create(root.path(), "..\\escape.pdf").is_err());
        state.remove(&path).unwrap();
        assert!(!Path::new(&path).exists());
        state.remove(&path).unwrap();
        let retained = state.create(root.path(), "report.pdf").unwrap();
        drop(state);
        assert!(!Path::new(&retained).exists());
    }

    #[cfg(unix)]
    #[test]
    fn retries_the_exact_owned_directory_when_cleanup_fails() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let state = DesktopDownloadsState::default();
        let path = state.create(root.path(), "report.pdf").unwrap();
        let directory = Path::new(&path).parent().unwrap();
        std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o500)).unwrap();
        // Root-owned test environments can bypass directory permissions.
        if File::create_new(directory.join("permission-probe")).is_ok() {
            std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700)).unwrap();
            state.remove(&path).unwrap();
            return;
        }
        assert!(state.remove(&path).is_err());
        std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700)).unwrap();
        state.remove(&path).unwrap();
        assert!(!Path::new(&path).exists());
    }
}
