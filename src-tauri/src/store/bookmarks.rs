use std::path::PathBuf;

/// Security-scoped bookmarks for macOS.
///
/// Because scripts are referenced in place (not copied), and the script folder
/// may be outside the app's container, macOS requires security-scoped bookmarks
/// to retain access across restarts (Plan.md §0, §M6).
///
/// On non-macOS platforms, this is a no-op.

#[cfg(target_os = "macos")]
pub struct BookmarkStore {
    pub bookmarks_dir: PathBuf,
}

// NSURLBookmarkCreationWithSecurityScope = 1 << 11
#[cfg(target_os = "macos")]
const BOOKMARK_CREATION_WITH_SECURITY_SCOPE: u64 = 1 << 11;

// NSURLBookmarkResolutionWithSecurityScope = 1 << 10
#[cfg(target_os = "macos")]
const BOOKMARK_RESOLUTION_WITH_SECURITY_SCOPE: u64 = 1 << 10;

#[cfg(target_os = "macos")]
mod ffi {
    #![allow(unexpected_cfgs)]
    use objc::{class, msg_send, sel, sel_impl};
    use objc::runtime::Object;
    use std::ffi::{CStr, CString};
    use std::os::raw::{c_char, c_void};
    use std::path::PathBuf;

    use super::{BOOKMARK_CREATION_WITH_SECURITY_SCOPE, BOOKMARK_RESOLUTION_WITH_SECURITY_SCOPE};

    fn ns_string(s: &str) -> *mut Object {
        unsafe {
            let c_str = CString::new(s).unwrap_or_else(|_| CString::new("").unwrap());
            let cls = class!(NSString);
            msg_send![cls, stringWithUTF8String: c_str.as_ptr() as *const c_char]
        }
    }

    /// Create a security-scoped bookmark for the given path.
    pub fn create_bookmark(path: &std::path::Path) -> Result<Vec<u8>, String> {
        unsafe {
            let path_str = path.to_string_lossy().into_owned();
            let ns_path = ns_string(&path_str);
            let cls = class!(NSURL);
            let url: *mut Object = msg_send![cls, fileURLWithPath: ns_path];
            if url.is_null() {
                return Err("fileURLWithPath returned nil".to_string());
            }

            let mut error: *mut Object = std::ptr::null_mut();
            let bookmark_data: *mut Object = msg_send![
                url,
                bookmarkDataWithOptions: BOOKMARK_CREATION_WITH_SECURITY_SCOPE
                includingResourceValuesForKeys: std::ptr::null::<c_void>()
                relativeToURL: std::ptr::null::<c_void>()
                error: &mut error as *mut *mut Object
            ];

            if bookmark_data.is_null() {
                if !error.is_null() {
                    let desc: *mut Object = msg_send![error, localizedDescription];
                    let desc_ptr: *const c_char = msg_send![desc, UTF8String];
                    if !desc_ptr.is_null() {
                        let desc_str = CStr::from_ptr(desc_ptr).to_string_lossy().into_owned();
                        return Err(format!("bookmarkDataWithOptions failed: {}", desc_str));
                    }
                }
                return Err("bookmarkDataWithOptions returned nil".to_string());
            }

            let bytes: *const c_void = msg_send![bookmark_data, bytes];
            let length: usize = msg_send![bookmark_data, length];
            if length == 0 {
                return Err("bookmark data is empty".to_string());
            }
            let slice = std::slice::from_raw_parts(bytes as *const u8, length);
            Ok(slice.to_vec())
        }
    }

    /// Resolve a security-scoped bookmark to a path.
    /// Returns (PathBuf, is_stale).
    pub fn resolve_bookmark(data: &[u8]) -> Result<(PathBuf, bool), String> {
        unsafe {
            let cls = class!(NSData);
            let ns_data: *mut Object = msg_send![
                cls,
                dataWithBytes: data.as_ptr() as *const c_void
                length: data.len()
            ];
            if ns_data.is_null() {
                return Err("dataWithBytes returned nil".to_string());
            }

            let mut is_stale: bool = false;
            let mut error: *mut Object = std::ptr::null_mut();
            let cls = class!(NSURL);
            let url: *mut Object = msg_send![
                cls,
                URLByResolvingBookmarkData: ns_data
                options: BOOKMARK_RESOLUTION_WITH_SECURITY_SCOPE
                relativeToURL: std::ptr::null::<c_void>()
                bookmarkDataIsStale: &mut is_stale as *mut bool
                error: &mut error as *mut *mut Object
            ];

            if url.is_null() {
                return Err("URLByResolvingBookmarkData returned nil".to_string());
            }

            let path_ptr: *const c_char = msg_send![url, fileSystemRepresentation];
            if path_ptr.is_null() {
                return Err("fileSystemRepresentation returned nil".to_string());
            }
            let path_cstr = CStr::from_ptr(path_ptr);
            Ok((PathBuf::from(path_cstr.to_string_lossy().into_owned()), is_stale))
        }
    }

    /// Start accessing a security-scoped resource by resolving bookmark data.
    /// This is the correct way: the URL must come from bookmark resolution,
    /// not reconstructed from a path string (audit H2).
    pub fn start_access_with_bookmark(data: &[u8]) -> Option<bool> {
        unsafe {
            let cls = class!(NSData);
            let ns_data: *mut Object = msg_send![
                cls,
                dataWithBytes: data.as_ptr() as *const c_void
                length: data.len()
            ];
            if ns_data.is_null() {
                return None;
            }

            let mut is_stale: bool = false;
            let mut error: *mut Object = std::ptr::null_mut();
            let cls = class!(NSURL);
            let url: *mut Object = msg_send![
                cls,
                URLByResolvingBookmarkData: ns_data
                options: BOOKMARK_RESOLUTION_WITH_SECURITY_SCOPE
                relativeToURL: std::ptr::null::<c_void>()
                bookmarkDataIsStale: &mut is_stale as *mut bool
                error: &mut error as *mut *mut Object
            ];

            if url.is_null() {
                return None;
            }

            let result: bool = msg_send![url, startAccessingSecurityScopedResource];
            Some(result)
        }
    }
}

#[cfg(target_os = "macos")]
impl BookmarkStore {
    pub fn new(app_support: &std::path::Path) -> Self {
        let dir = app_support.join("bookmarks");
        std::fs::create_dir_all(&dir).ok();
        Self { bookmarks_dir: dir }
    }

    pub fn save_bookmark(&self, script_id: &str, path: &std::path::Path) -> std::io::Result<()> {
        let bookmark_file = self.bookmarks_dir.join(format!("{}.bookmark", script_id));
        match ffi::create_bookmark(path) {
            Ok(data) => std::fs::write(&bookmark_file, &data),
            Err(e) => {
                tracing::warn!("Failed to create security-scoped bookmark: {}, falling back to path", e);
                let path_file = self.bookmarks_dir.join(format!("{}.path", script_id));
                std::fs::write(&path_file, path.to_string_lossy().as_bytes())
            }
        }
    }

    pub fn resolve_bookmark(&self, script_id: &str) -> Option<PathBuf> {
        let bookmark_file = self.bookmarks_dir.join(format!("{}.bookmark", script_id));
        if bookmark_file.exists() {
            if let Ok(data) = std::fs::read(&bookmark_file) {
                if let Ok((path, is_stale)) = ffi::resolve_bookmark(&data) {
                    if is_stale {
                        tracing::warn!("Bookmark for '{}' is stale — path may be outdated", script_id);
                    }
                    return Some(path);
                }
            }
        }
        let path_file = self.bookmarks_dir.join(format!("{}.path", script_id));
        std::fs::read_to_string(&path_file)
            .ok()
            .map(PathBuf::from)
    }

    pub fn start_access(&self, script_id: &str) -> bool {
        let bookmark_file = self.bookmarks_dir.join(format!("{}.bookmark", script_id));
        if bookmark_file.exists() {
            if let Ok(data) = std::fs::read(&bookmark_file) {
                // Use bookmark-based access (correct security scope — audit H2)
                if let Some(result) = ffi::start_access_with_bookmark(&data) {
                    return result;
                }
            }
        }
        // No bookmark or resolution failed — without sandbox, access always succeeds
        true
    }

    pub fn stop_access(&self, _script_id: &str) {
        // stopAccessingSecurityScopedResource must be called on the same NSURL
        // object that startAccessingSecurityScopedResource was called on.
        // Since we don't retain the URL across calls, we can't call stop here.
        // With App Sandbox OFF (Plan.md §0), this is a no-op in practice.
        // The OS balances the retain count automatically when the process exits.
    }
}

#[cfg(not(target_os = "macos"))]
pub struct BookmarkStore {
    pub bookmarks_dir: PathBuf,
}

#[cfg(not(target_os = "macos"))]
impl BookmarkStore {
    pub fn new(app_support: &std::path::Path) -> Self {
        let dir = app_support.join("bookmarks");
        std::fs::create_dir_all(&dir).ok();
        Self { bookmarks_dir: dir }
    }

    pub fn save_bookmark(&self, _script_id: &str, _path: &std::path::Path) -> std::io::Result<()> {
        Ok(())
    }

    pub fn resolve_bookmark(&self, _script_id: &str) -> Option<PathBuf> {
        None
    }

    pub fn start_access(&self, _script_id: &str) -> bool {
        true
    }

    pub fn stop_access(&self, _script_id: &str) {}
}

// ---------------------------------------------------------------------------
// Tests (Plan.md §3.2)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pyshell-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn new_creates_bookmarks_dir() {
        let dir = tmp_dir();
        let store = BookmarkStore::new(&dir);
        assert!(store.bookmarks_dir.exists());
        assert_eq!(store.bookmarks_dir, dir.join("bookmarks"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn resolve_bookmark_reads_path_fallback() {
        let dir = tmp_dir();
        let store = BookmarkStore::new(&dir);

        // Write a `.path` file directly (simulates the bookmark-creation fallback)
        let path_file = store.bookmarks_dir.join("test.path");
        std::fs::write(&path_file, "/some/path/to/script.py").unwrap();

        let resolved = store.resolve_bookmark("test");
        assert_eq!(resolved, Some(PathBuf::from("/some/path/to/script.py")));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn resolve_bookmark_returns_none_when_nothing_exists() {
        let dir = tmp_dir();
        let store = BookmarkStore::new(&dir);
        let resolved = store.resolve_bookmark("nonexistent");
        assert_eq!(resolved, None);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn start_access_returns_true_without_bookmark() {
        let dir = tmp_dir();
        let store = BookmarkStore::new(&dir);
        // No bookmark file — without sandbox, access always succeeds
        assert!(store.start_access("nonexistent"));
        std::fs::remove_dir_all(&dir).ok();
    }
}
