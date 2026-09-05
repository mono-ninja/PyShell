fn main() {
    // Windows note, kept here because this is where the obvious "fix" goes and
    // it does not work:
    //
    // `tauri-plugin-dialog` pulls in `rfd` with its `common-controls-v6`
    // feature, which imports `TaskDialogIndirect` from `comctl32.dll`. That
    // function exists only in ComCtl32 **v6**, and a process gets v6 only when
    // its application manifest requests the side-by-side assembly.
    // `tauri_build` compiles exactly such a manifest (its default
    // `windows-app-manifest.xml` already declares Common-Controls 6.0.0.0)
    // into a Windows *resource*, and that resource reaches the **app binary
    // only**. A `cargo test` binary therefore loads against ComCtl32 v5, the
    // entry point is missing, and the process dies before the first test:
    // `exit code: 0xc0000139, STATUS_ENTRYPOINT_NOT_FOUND`.
    //
    // `cargo:rustc-link-arg-tests` looks like the answer and is not: cargo
    // rejects it unless the package has a real test target (`tests/*.rs`) —
    // "invalid instruction `cargo:rustc-link-arg-tests` … does not have a test
    // target" — and even with one it would apply to that integration-test
    // binary, not to the lib's own unit-test binary, which is the one that
    // fails. The unscoped `cargo:rustc-link-arg` does reach it, but it also
    // reaches the app binary, where a linker-generated manifest would collide
    // with the resource `tauri_build` already embeds.
    //
    // So the Windows CI job must not run `cargo test` until this is solved for
    // real. See AGENTS.md (Build) and CLAUDE.md (Known gaps).
    tauri_build::build()
}
