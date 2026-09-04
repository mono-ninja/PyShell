/**
 * External URLs the app points at.
 *
 * One constant per destination so a move needs one edit. The Rust side has its
 * own copies: `src-tauri/src/menu.rs` (`SCRIPTS_URL`, for the Help menu, which
 * opens the URL without involving the webview) and `src-tauri/src/repo.rs`
 * (owner/name/branch constants the Store fetches from) — keep all of them in
 * step.
 */

/** The community collection of ready-made scripts. */
export const SCRIPTS_URL = "https://github.com/mono-ninja/PyShell-scripts";
