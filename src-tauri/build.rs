fn main() {
    // Windows: give **test** binaries the ComCtl32 v6 manifest dependency that
    // `tauri_build` embeds only into the app binary.
    //
    // `tauri-plugin-dialog` pulls in `rfd` with its `common-controls-v6`
    // feature, which imports `TaskDialogIndirect` from `comctl32.dll`. That
    // function exists only in ComCtl32 **v6**, and Windows hands a process v5
    // unless the binary's application manifest asks for the v6 side-by-side
    // assembly. The app binary gets such a manifest from `tauri_build`; a
    // `cargo test` binary is a different target and gets none, so the loader
    // binds v5, fails to find the entry point, and kills the process before a
    // single test runs — `exit code: 0xc0000139, STATUS_ENTRYPOINT_NOT_FOUND`.
    //
    // `rustc-link-arg-tests` scopes this to test binaries on purpose: adding it
    // to the app binary as well would put a linker-generated manifest next to
    // the resource `tauri_build` already embeds there.
    //
    // MSVC only — `/MANIFEST*` are link.exe options, and the `-gnu` target
    // would reject them.
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    if target_os == "windows" && target_env == "msvc" {
        println!("cargo:rustc-link-arg-tests=/MANIFEST:EMBED");
        println!(
            "cargo:rustc-link-arg-tests=/MANIFESTDEPENDENCY:type='win32' \
             name='Microsoft.Windows.Common-Controls' version='6.0.0.0' \
             processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'"
        );
    }

    tauri_build::build()
}
