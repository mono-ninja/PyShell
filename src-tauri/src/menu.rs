//! The native application menu.
//!
//! This is not decoration: on macOS the standard editing shortcuts only reach a
//! webview through the main menu. AppKit dispatches ⌘V to the responder chain as
//! the `paste:` selector *because a menu item carries that key equivalent* — with
//! no such item the keystroke is swallowed and only the webview's own context
//! menu can paste. The items therefore have to be [`PredefinedMenuItem`]s, which
//! map onto those selectors; a custom item running `document.execCommand("paste")`
//! cannot substitute, because reading the clipboard from script is blocked.
//! ⌘Q and ⌘W are the same story: without `quit` / `close_window` items nothing
//! quits the app or closes the window.
//!
//! The Favorites submenu is the exception to "built once": its items carry the
//! pinned scripts' own names and ⌘1…⌘9, so it is rebuilt (whole menu re-set)
//! whenever the pinned set or a pinned script's name changes — see
//! `commands::favorites::sync_menu`, which skips the rebuild when nothing moved.
//!
//! Everything app-specific (run, cancel, panes, docs, find, settings) is emitted
//! to the frontend as [`MENU_EVENT`] with the item id as payload. The menu is the
//! **only** owner of those shortcuts — `app.tsx` deliberately no longer binds
//! them on `window`, since a key equivalent claimed by the menu never reaches the
//! webview on macOS, and on Windows it is consumed by the accelerator table, so a
//! second binding would either be dead code or double-fire a toggle.
//!
//! Accelerator strings are parsed at build time and the error is propagated out
//! of `setup`, i.e. a typo here means the app does not start. Keep to the forms
//! `muda::accelerator` understands: `CmdOrCtrl`/`Shift`/`Alt` + a single letter,
//! digit, punctuation character, or named key such as `Enter`.

use tauri::menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Emitter, Manager, Runtime};

/// Event carrying a menu item id to the frontend.
pub const MENU_EVENT: &str = "menu:action";

/// Items handled in Rust rather than forwarded to the webview.
const SHOW_LOGS: &str = "show_logs";

/// Handled here rather than in the frontend: opening a URL needs no UI state,
/// and going through the webview would only add a hop.
const HELP_SCRIPTS: &str = "help:scripts";
/// The community script collection — where users get something to run.
pub const SCRIPTS_URL: &str = "https://github.com/mono-ninja/PyShell-scripts";
/// Routed to the frontend, which renders the guide in an overlay.
const HELP_GUIDE: &str = "help:guide";

/// One pinned script: its id and the name to show in the menu.
pub type Favorite = (String, String);

pub fn build<R: Runtime, M: Manager<R>>(app: &M, favorites: &[Favorite]) -> tauri::Result<Menu<R>> {
    let show_logs = MenuItem::with_id(app, SHOW_LOGS, "Show Logs in Finder", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, Some("CmdOrCtrl+,"))?;
    // ⌘O opens the file picker rather than the folder picker: a single .py is
    // the common case, and the folder import is one shift away.
    let import_file =
        MenuItem::with_id(app, "import:file", "Import Script…", true, Some("CmdOrCtrl+O"))?;
    let import_folder = MenuItem::with_id(
        app,
        "import:folder",
        "Import Folder…",
        true,
        Some("CmdOrCtrl+Shift+O"),
    )?;

    // --- App / File -------------------------------------------------------
    //
    // On macOS the first submenu *is* the application menu, whatever it is
    // called, and it is where About/Services/Hide/Quit belong. Elsewhere those
    // items do not exist, so the same slot becomes a plain File menu.
    #[cfg(target_os = "macos")]
    let app_menu = Submenu::with_items(
        app,
        "PyShell",
        true,
        &[
            &PredefinedMenuItem::about(
                app,
                Some("About PyShell"),
                Some(
                    tauri::menu::AboutMetadataBuilder::new()
                        .name(Some("PyShell"))
                        .version(Some(env!("CARGO_PKG_VERSION")))
                        .build(),
                ),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &settings,
            &show_logs,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, Some("Hide PyShell"))?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, Some("Quit PyShell"))?,
        ],
    )?;

    // Elsewhere there is no application menu, so the same slot is the File menu
    // and absorbs the imports below.
    #[cfg(not(target_os = "macos"))]
    let app_menu = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &import_file,
            &import_folder,
            &PredefinedMenuItem::separator(app)?,
            &settings,
            &show_logs,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
            &PredefinedMenuItem::quit(app, Some("Exit"))?,
        ],
    )?;

    // --- File (macOS only; folded into the menu above elsewhere) ----------
    #[cfg(target_os = "macos")]
    let file_menu = Submenu::with_items(app, "File", true, &[&import_file, &import_folder])?;

    // --- Edit -------------------------------------------------------------
    //
    // The reason this file exists. All predefined, all standard accelerators.
    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "find", "Find Script…", true, Some("CmdOrCtrl+F"))?,
        ],
    )?;

    // --- View -------------------------------------------------------------
    let view_menu = Submenu::with_items(
        app,
        "View",
        true,
        &[
            // ⇧⌘digit, because plain ⌘digit belongs to Favorites. Shift rather
            // than Ctrl: `CmdOrCtrl` *is* Ctrl off macOS, so Ctrl+1 would be the
            // same chord as a favorite there.
            &MenuItem::with_id(app, "pane:params", "Parameters", true, Some("CmdOrCtrl+Shift+1"))?,
            &MenuItem::with_id(app, "pane:output", "Output", true, Some("CmdOrCtrl+Shift+2"))?,
            &MenuItem::with_id(app, "pane:results", "Results", true, Some("CmdOrCtrl+Shift+3"))?,
            &MenuItem::with_id(app, "pane:history", "History", true, Some("CmdOrCtrl+Shift+4"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "docs", "Toggle Docs", true, Some("CmdOrCtrl+D"))?,
        ],
    )?;

    // --- Favorites ---------------------------------------------------------
    //
    // Only the first nine get an accelerator; pinning a tenth script still
    // works, it just has no number. The items are owned by locals so the
    // `&dyn` slice below can borrow them.
    let toggle_favorite = MenuItem::with_id(
        app,
        "favorite:toggle",
        "Pin / Unpin Current Script",
        true,
        Some("CmdOrCtrl+Shift+F"),
    )?;
    let no_favorites = MenuItem::with_id(
        app,
        "favorite:none",
        "No pinned scripts",
        false,
        None::<&str>,
    )?;
    let favorite_items = favorites
        .iter()
        .enumerate()
        .map(|(i, (id, name))| {
            let accelerator = (i < 9).then(|| format!("CmdOrCtrl+{}", i + 1));
            MenuItem::with_id(app, format!("fav:{id}"), name, true, accelerator)
        })
        .collect::<tauri::Result<Vec<_>>>()?;

    let separator = PredefinedMenuItem::separator(app)?;
    let mut favorite_refs: Vec<&dyn IsMenuItem<R>> = vec![&toggle_favorite, &separator];
    if favorite_items.is_empty() {
        favorite_refs.push(&no_favorites);
    } else {
        favorite_refs.extend(favorite_items.iter().map(|i| i as &dyn IsMenuItem<R>));
    }
    let favorites_menu = Submenu::with_items(app, "Favorites", true, &favorite_refs)?;

    // --- Run --------------------------------------------------------------
    //
    // ⌘↩ rather than ⌘R for Run: the webview treats ⌘R as reload, which would
    // throw away the running job.
    let run_menu = Submenu::with_items(
        app,
        "Run",
        true,
        &[
            &MenuItem::with_id(app, "run", "Run Script", true, Some("CmdOrCtrl+Enter"))?,
            &MenuItem::with_id(app, "cancel", "Cancel Run", true, Some("CmdOrCtrl+."))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "preview", "Preview Command", true, Some("CmdOrCtrl+Shift+P"))?,
            &MenuItem::with_id(app, "reset", "Reset Fields", true, None::<&str>)?,
        ],
    )?;

    // --- Window -----------------------------------------------------------
    #[cfg(target_os = "macos")]
    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, Some("Zoom"))?,
            // Full screen lives here rather than in View because the predefined
            // item is macOS-only, and this whole submenu already is.
            &PredefinedMenuItem::fullscreen(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            // Closing hides the window instead of destroying it — see the
            // CloseRequested handler in lib.rs.
            &PredefinedMenuItem::close_window(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::bring_all_to_front(app, None)?,
        ],
    )?;

    // --- Help --------------------------------------------------------------
    //
    // No accelerators here on purpose: these are rare, discoverable actions,
    // and an unparseable accelerator string aborts `setup` — the app would not
    // launch at all. Not worth the risk for a menu nobody reaches for twice.
    let help_menu = Submenu::with_items(
        app,
        "Help",
        true,
        &[
            &MenuItem::with_id(app, HELP_GUIDE, "How to Write a Script", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, HELP_SCRIPTS, "Browse Script Library…", true, None::<&str>)?,
        ],
    )?;

    #[cfg(target_os = "macos")]
    let menu = Menu::with_items(
        app,
        &[
            &app_menu,
            &file_menu,
            &edit_menu,
            &view_menu,
            &favorites_menu,
            &run_menu,
            &window_menu,
            &help_menu,
        ],
    )?;
    #[cfg(not(target_os = "macos"))]
    let menu = Menu::with_items(
        app,
        &[&app_menu, &edit_menu, &view_menu, &favorites_menu, &run_menu, &help_menu],
    )?;

    Ok(menu)
}

/// Route a menu click. Predefined items never arrive here — the OS acts on them
/// directly — so this only sees our own ids.
pub fn handle_event(app: &tauri::AppHandle, event: tauri::menu::MenuEvent) {
    let id = event.id().0.as_str();
    if id == SHOW_LOGS {
        crate::logging::show_logs_in_finder(app);
        return;
    }
    // Hand the URL to the OS browser. Doing this here keeps it working even
    // when the window is hidden, which the block below would otherwise undo.
    if id == HELP_SCRIPTS {
        if let Err(e) = tauri_plugin_opener::open_url(SCRIPTS_URL, None::<&str>) {
            tracing::error!("failed to open {SCRIPTS_URL}: {e}");
        }
        return;
    }
    // ⌘W may have hidden the window. Acting on a hidden UI — starting a run
    // nobody can see — is worse than bringing it back first, and reaching for a
    // menu item is the user asking for the app anyway.
    if let Some(window) = app.get_webview_window("main") {
        if !window.is_visible().unwrap_or(true) {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }

    // Anything else is a frontend action. Emitting to the app (rather than to a
    // specific window) keeps this working if a second window is ever added.
    if let Err(e) = app.emit(MENU_EVENT, id) {
        tracing::error!("failed to emit menu event {id}: {e}");
    }
}
