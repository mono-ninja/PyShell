/**
 * External URLs the app points at.
 *
 * One constant per destination so a move needs one edit. The Rust side has its
 * own copy in `src-tauri/src/menu.rs` (`SCRIPTS_URL`), because the Help menu
 * opens the URL without involving the webview — keep the two in step.
 */

/** The community collection of ready-made scripts. */
export const SCRIPTS_URL = "https://github.com/mono-ninja/PyShell-scripts";
