# Third-party licenses

PyShell itself is released under the MIT License (see [`LICENSE`](LICENSE)).
It is built on, and redistributes, the third-party software listed below.

## Redistributed in the application bundle

### uv — Astral Software Inc.

Licensed under **MIT OR Apache-2.0**.

The `uv` binary is bundled inside every PyShell release as a Tauri sidecar
(`src-tauri/binaries/uv-<target-triple>`) and is what provisions Python
interpreters and per-script virtual environments. Because the binary itself is
redistributed, both licenses require the notice to travel with it: the full
texts are fetched by `npm run fetch-uv` into `src-tauri/licenses/uv/` and
bundled as an application resource.

- Upstream: https://github.com/astral-sh/uv
- Copyright (c) 2025 Astral Software Inc.
- License texts: [`src-tauri/licenses/uv/LICENSE-MIT`](src-tauri/licenses/uv/LICENSE-MIT),
  [`src-tauri/licenses/uv/LICENSE-APACHE`](src-tauri/licenses/uv/LICENSE-APACHE)

Note that `uv` in turn downloads Python interpreters at runtime. Those are
distributed by upstream (python-build-standalone / the PSF) under their own
terms and are **not** redistributed by PyShell.

## Linked into the application

The Rust backend links roughly 600 crates and the frontend ships Preact. The
overwhelming majority are permissive (`MIT`, `Apache-2.0`, `BSD-3-Clause`,
`ISC`, `Unicode-3.0`, `Zlib`). Notable entries:

| Component | Version | License | Upstream |
|---|---|---|---|
| `tauri` | 2.11.5 | Apache-2.0 OR MIT | https://github.com/tauri-apps/tauri |
| `preact` | 10.x | MIT | https://github.com/preactjs/preact |
| `ring` | 0.17.14 | Apache-2.0 AND ISC | https://github.com/briansmith/ring |

### Mozilla Public License 2.0 components

These crates are pulled in transitively (via Tauri's webview and styling stack)
and are licensed under the **MPL-2.0**, a file-level weak copyleft license.
They are used unmodified and merely linked, which MPL-2.0 §3.3 permits within a
larger work distributed under different terms. Should any of these files be
modified, the modified files must be made available under the MPL-2.0.

| Crate | Version | Upstream |
|---|---|---|
| `cssparser` | 0.36.0 | https://github.com/servo/rust-cssparser |
| `cssparser-macros` | 0.6.1 | https://github.com/servo/rust-cssparser |
| `selectors` | 0.36.1 | https://github.com/servo/stylo |
| `dtoa-short` | 0.3.5 | https://github.com/upsuper/dtoa-short |
| `option-ext` | 0.2.0 | https://github.com/soc/option-ext |

No GPL, AGPL, or SSPL-licensed dependency is present in the build.

## Regenerating this list

```bash
cargo metadata --manifest-path src-tauri/Cargo.toml --format-version 1 \
  | python3 -c "import json,sys,collections; \
      c=collections.Counter(p.get('license') or 'UNKNOWN' for p in json.load(sys.stdin)['packages']); \
      [print(f'{n:5d}  {l}') for l,n in c.most_common()]"
```
