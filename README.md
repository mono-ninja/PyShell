# PyShell

A desktop GUI for running Python scripts: a sidebar of your scripts, a form
generated from a manifest, an isolated virtual environment per script, and live
output streaming.

Built with Tauri v2 + Rust + Preact. Instead of a system Python it bundles
[`uv`](https://github.com/astral-sh/uv) as a sidecar binary, which downloads the
interpreter each script asks for — so **Python does not need to be installed**.

## Platforms

**macOS only, for now** — arm64 and x86_64, shipped as one universal build.
That is also the only platform anything is built or tested on: `bundle.targets`
in `tauri.conf.json` is `["app", "dmg"]`, and both CI and the release workflow
run on macOS runners alone.

- **Windows** — the `#[cfg(windows)]` code in `runner/` exists but is compiled
  by nothing and has never been executed. Its blocker is written up in
  `src-tauri/build.rs`: the test binary cannot load, because `rfd` needs a
  ComCtl32 v6 manifest that only the app binary gets. Re-enabling it is a
  scoped piece of work, not a flag.
- **Linux** — out of scope (see `AGENTS.md`).

---

## Installing and first launch

Download the `.dmg` from the
[Releases](https://github.com/mono-ninja/PyShell/releases) page.

**Builds are not code-signed**, so macOS will warn you the first time. This is
expected — signing requires a paid Apple Developer ID. Every later launch opens
normally.

### macOS

Open the `.dmg` and drag **PyShell** into Applications. Then, on the *first*
launch only:

1. Open the Applications folder in Finder.
2. **Right-click** PyShell → **Open** (double-clicking will not offer the
   option — the dialog only has *Move to Trash*).
3. Confirm **Open** in the dialog.

If macOS still refuses with *"PyShell is damaged and can't be opened"* — that is
Gatekeeper reacting to the quarantine flag on an unsigned download, not a real
corruption — clear the flag:

```bash
xattr -dr com.apple.quarantine /Applications/PyShell.app
```

Alternatively, launch it once, then open **System Settings → Privacy & Security**
and press **Open Anyway** next to the PyShell notice.

### First run inside the app

The window opens with an empty sidebar. To get from there to a running script:

1. **Add a script.** Press **+ File** for a single `.py`, or **+ Folder** for a
   project containing a `pyshell.yaml` (⌘O / ⇧⌘O). The script stays where it
   is — PyShell only stores a reference, never a copy. Nothing to hand?
   Grab one from
   [mono-ninja/PyShell-scripts](https://github.com/mono-ninja/PyShell-scripts).
2. **Prepare the environment.** Press **Prepare Env** in the header. On the very
   first run this also downloads a Python interpreter, so expect it to take a
   minute and to need a network connection. If the script has a
   `requirements.txt`, PyShell lists the packages and asks before installing.
3. **Fill in the form and press Run** (⌘↩). Output streams into the Output tab
   as it happens.

Two things worth knowing straight away: **⌘W hides the window instead of
quitting** (a running script keeps going; click the Dock icon to return), and
**PyShell → Show Logs in Finder** opens the rotated application log if something
goes wrong.

---

## Building from source

### Requirements

- [Node.js](https://nodejs.org/) 18+
- [Rust](https://rustup.rs/) 1.77+
- [Tauri CLI 2](https://v2.tauri.app/) (installed via npm)
- macOS: Xcode Command Line Tools
- Windows: Microsoft Visual C++ Build Tools

### Running in development

```bash
# 1. Install npm dependencies
npm install

# 2. Download the uv sidecar for your platform
#    (not in git — ~40 MB per target)
npm run fetch-uv

# 3. Start the app in dev mode
npx tauri dev
```

Without the sidecar not even `cargo check` succeeds: `tauri_build` copies every
`externalBin` inside `build.rs` and fails with
`resource path "binaries/uv-<triple>" doesn't exist`. To build for another
target, pass it explicitly: `npm run fetch-uv -- x86_64-pc-windows-msvc`.

### Checks and build

Run `cargo test` **first** on a fresh clone: it generates `src/types/bindings/`
(ts-rs), without which `tsc` fails with confusing errors in `app.tsx`.

```bash
# Rust tests + ts-rs binding generation
cargo test --manifest-path src-tauri/Cargo.toml

# Rust typecheck
cargo check --manifest-path src-tauri/Cargo.toml

# TypeScript typecheck
npx tsc --noEmit

# Frontend tests
npm test

# Full bundle
npx tauri build
```

---

## Using PyShell

### 1. Importing a script

Import a local script with **+ Folder** (a project with `pyshell.yaml`) or
**+ File** (a single `.py`) in the sidebar — or install one from the community
repo with **+ Store** (also in File ▸ Add from Store…): pick a destination
folder once, press **Install** on a script, and PyShell downloads it there and
imports it exactly like a local folder. The destination is remembered for next
time, the catalog is cached for the session (**Refresh** re-fetches it; GitHub
allows 60 API requests per hour without a token, and a catalog fetch spends
one), and installed scripts are badged — a script whose folder was deleted
shows a **Missing folder** warning instead, pointing at the relink flow in the
sidebar.

When the repo carries a newer `version` than an installed script, the store
offers **Update** instead of the badge — and a small dot on the **+ Store**
button says so without opening it. The update replaces the script's folder with
the repo's current contents (the old folder is kept as a `<name>.backup-…`
sibling — only the newest backup survives, older ones are pruned — so nothing
is lost), while presets, history and secrets — keyed by
script id — carry over. The environment flips to *Stale* and rebuilds if the
dependencies changed. Updates are blocked while the script is running.

Installed rows also carry **Repair** (re-download the folder over the existing
files, without any version comparison — for installs that went bad) and
**Uninstall** (the sidebar's Remove, without leaving the dialog: removes the
script, its environment, presets, history and secrets; the folder itself stays
on disk). Both confirm before acting.

The interface ships in English and Ukrainian — Settings ▸ Appearance switches
the language (the choice persists; the system locale is the default).

The catalog is checked against GitHub when the app starts and at most once
every five minutes after that (a check costs 2 of the 60 unauthenticated API
requests per hour); **Refresh** always re-checks immediately. File downloads
are pinned to the repo's latest commit, so a fresh push is visible without
waiting for GitHub's CDN cache.

Three ways to describe a script's parameters, in priority order:

1. **`pyshell.yaml`** — a YAML manifest beside the script
2. **PEP 723** — an inline TOML block in the `.py` file's comments
3. **Introspection** — automatic analysis of `argparse`/`click`/`typer`
   (requires a prepared environment)

With no manifest a minimal schema is generated; you can run introspection later
for a better one.

You can put a page for whoever *runs* the script (what the fields mean, what to
expect) beside it and PyShell shows it in the **Docs** panel (⌘D). For a project
folder that is **`pyshell.md`**, for a single file **`<script-name>.md`** (e.g.
`report-demo.md` next to `report-demo.py`), because several scripts can share a
directory. With neither, `README.md` is shown. Files are looked up in a
**`docs/`** subfolder first, and only if it is absent or empty in the script's
own directory. Translations use a suffix: `pyshell_ua.md` alongside `pyshell.md`
adds a language picker to the panel. A CommonMark subset is rendered; HTML is
never executed and links open in the system browser.

### 2. Preparing the environment

Press **Prepare Env** in the header. PyShell:

1. Creates an isolated venv with `uv venv` at the requested Python version
2. If a `requirements.txt` exists, lists the packages and asks for confirmation
3. Installs them with `uv pip install -r requirements.txt`

Each script gets its own venv. Changing the dependencies rebuilds it
automatically.

### 3. Running

Fill in the form and press **Run**. Output streams live:

- **Output** — stdout/stderr with filtering, search and autoscroll
- **Results** — structured events (progress, table, chart, markdown) and artifacts
- **History** — recent runs with Retry, run comparison, and CSV/JSON export

**Run** stays disabled while the form is invalid (required, min/max, pattern).

### 4. Secrets

A `secret` field is stored in the macOS Keychain / Windows Credential Manager.
The value never returns to the frontend and is never written to state. It is
passed to the process through an environment variable, never through argv.
Settings ▸ Secrets lists every stored secret across all scripts (script, key,
date) with a per-entry delete; removing a script deletes its secrets along
with it.

### 5. Presets

Save a set of parameters as a preset (type a name → **Save**). Presets load with
one click.

### 6. Introspection (for scripts without a manifest)

If the schema was guessed (**Guessed** badge):

1. Prepare the environment first (**Prepare Env**)
2. Press **Introspect** in the banner
3. Confirm in the consent dialog — this executes arbitrary code from the script
4. Press **Save Manifest** to store the result as `pyshell.yaml`

### 7. Favorites

Right-click a script → **Pin to Favorites**, the star that appears on hover, or
⇧⌘F for the current one. Pinned scripts move to their own section at the top of
the sidebar and get the numbers **⌘1…⌘9**, in the order you added them. Sorting
A→Z does not disturb that order: the position *is* the shortcut, so a number must
not change on its own. The same entries, with script names, appear in the
**Favorites** menu. A pinned script disappears from its category below — it is
never shown twice.

---

## Keyboard shortcuts

Every shortcut lives in the native menu (`src-tauri/src/menu.rs`) rather than in
the webview — otherwise macOS simply would not deliver it to the app. That is
also why the system ones work: ⌘C/⌘V/⌘X/⌘A/⌘Z in form fields, ⌘Q to quit, ⌘W to
hide the window (the run and the form survive; clicking the Dock icon brings it
back).

| Keys | Action |
| --- | --- |
| ⌘O / ⇧⌘O | Import script / folder |
| ⌘, | Settings |
| ⌘F | Search the script list |
| ↑ / ↓ | Move through the script list |
| ⌘1…⌘9 | Favorite script #1…#9 |
| ⇧⌘F | Pin / unpin the current script |
| ⇧⌘1…⇧⌘4 | Parameters / Output / Results / History |
| ⌘D | Docs panel |
| ⌘↩ | Run script |
| ⌘. | Cancel run |
| ⇧⌘P | Show the command line |
| ⌘M / ⌘W / ⌘Q | Minimise / hide / quit |
| Esc | Close a dialog or context menu |

On Windows and Linux, ⌘ means Ctrl.

---

## The `pyshell.yaml` manifest

```yaml
schema: 1
id: com.example.my-script      # optional; otherwise local.<hash>
name: My Script
description: Description
icon: 🔧
category: Tools
needs:                          # other PyShell scripts this one expects, by id
  - com.pyshell.sitecrawler

runtime:
  entry: main.py               # relative to pyshell.yaml
  python: ">=3.11,<3.14"
  requirements: requirements.txt  # optional
  timeout: 60                   # seconds; optional

inputs:
  - key: url
    type: url
    label: URL
    required: true
    binding:
      kind: arg
      flag: "--url"
      style: space

  - key: count
    type: int
    label: Count
    default: 1
    min: 1
    max: 100
    binding:
      kind: arg
      flag: "--count"
      style: space

  - key: verbose
    type: bool
    default: false
    binding:
      kind: arg
      flag: "--verbose"
      style: flag

  - key: tags
    type: multi_choice
    options:
      - value: a
      - value: b
    binding:
      kind: arg
      flag: "--tag"
      style: repeat

outputs:
  artifacts:
    - "*.csv"
  result: none
```

The full guide — every field type, bindings, conditional visibility, structured
events, artifacts — is built into the app: **Help → How to Write a Script**.

### Script dependencies (`needs`)

A script can expect **other PyShell scripts** to be installed — declare their
manifest ids in `needs:` (see the example above). The header then warns with a
`Needs: …` pill while any of them is missing, the sidebar marks scripts with
dependencies (the marker turns amber while one is missing), the Store installs
the missing ones alongside automatically, and at run time every installed
dependency's folder is passed as a JSON object in the `PYSHELL_DEPS` env var
(`json.loads(os.environ["PYSHELL_DEPS"])` → `{"com.pyshell.sitecrawler":
"/abs/folder"}`). `needs` is an expectation, not a lock — a missing dependency
never blocks the run, it is just absent from the map. The full guide covers the
four dependency kinds (data, subprocess, import, optional synergy).

### Field types

| Type | Description | Binding |
|---|---|---|
| `string` | Text | `arg` / `env` / `positional` / `stdin` / `temp_file` |
| `multiline` | Multi-line text | `temp_file` recommended |
| `int` | Integer with min/max | any |
| `float` | Number with min/max | any |
| `bool` | Yes/no | `arg` with `style: flag` |
| `choice` | Dropdown | any |
| `multi_choice` | Multi-select | `arg` with `style: repeat` or `joined` |
| `file` / `files` / `dir` | File / folder picker | any |
| `save_path` | Save location | any |
| `secret` | Password (keychain) | `env` only |
| `date` | Date | any |
| `url` | URL | any |

### Argument styles (`ArgStyle`)

| Style | Example |
|---|---|
| `space` | `--url https://example.com` |
| `equals` | `--url=https://example.com` |
| `flag` | `--verbose` (only when true) |
| `repeat` | `--tag a --tag b` |
| `joined` | `--tags a,b` (with `sep: ","`) |

### Conditional visibility (`visible_if`)

```yaml
- key: mode
  type: choice
  options: [{value: simple}, {value: advanced}]
  default: simple
  binding: {kind: arg, flag: "--mode", style: space}

- key: advanced_option
  type: string
  visible_if:
    op: eq
    key: mode
    value: advanced
  binding: {kind: arg, flag: "--advanced", style: space}
```

Operators: `eq`, `ne`, `truthy`.

---

## Structured events from a script

A script can print JSON to stderr to render progress, tables, markdown, charts
and a status line. **The JSON must contain `"pyshell": true`** — otherwise the
line is treated as an ordinary log entry, so scripts that log `{"error": ...}`
to stderr do not vanish:

```python
import json, sys

def emit(event):
    event["pyshell"] = True
    print(json.dumps(event), file=sys.stderr, flush=True)  # flush is required

# Progress bar (pct is 0..100)
emit({"type": "progress", "pct": 50, "message": "Processing..."})

# Table
emit({"type": "table", "columns": ["URL", "Status"], "rows": [["https://x.com", "OK"]]})

# Markdown result (a CommonMark subset; HTML is not executed)
emit({"type": "markdown", "content": "## Done\n\nFound **3** entries."})

# Chart (line | bar)
emit({
    "type": "chart",
    "chart_type": "line",
    "title": "Response time",
    "labels": ["/", "/api"],
    "series": [{"name": "p50", "values": [12, 45]}],
})

# Status
emit({"type": "status", "message": "Done"})
```

stderr lines that are not JSON, or lack `"pyshell": true`, appear as ordinary log
output.

`progress`, `table`, `markdown`, `chart` and `status` **replace** the previous
value rather than appending. Events are not batched and count toward the same
output cap as log lines (50 MB / 500k lines per run), so throttle them — one per
whole percent is plenty. Do not use `rich`/`tqdm` for progress: PyShell uses
pipes, not a PTY.

---

## Ready-made scripts

A collection of scripts for PyShell lives in a separate repository:
**[mono-ninja/PyShell-scripts](https://github.com/mono-ninja/PyShell-scripts)**.

Each ships a manifest, so it works straight after import. The easiest way is
**+ Store** in the sidebar: browse the catalog, press **Install**, and the
folder is downloaded into a destination you choose and imported in one step.
The manual route still works too — download the folder (or a single `.py`) and
add it with **Import Script…** (⌘O) or **Import Folder…**. PyShell installs
the dependencies into an isolated venv itself — just press *Prepare Env*.

---

## Where data is stored

| What | Where |
|---|---|
| Script list | `~/Library/Application Support/com.pyshell.app/scripts.json` |
| Favorites (⌘1…⌘9) | `~/Library/Application Support/com.pyshell.app/favorites.json` |
| Schemas | `~/Library/Application Support/com.pyshell.app/schemas/` |
| Virtual environments | `~/Library/Application Support/com.pyshell.app/envs/` |
| Run output | `~/Library/Application Support/com.pyshell.app/output/` |
| State (values, presets, history) | `~/Library/Application Support/com.pyshell.app/state/` |
| Logs | `~/Library/Application Support/com.pyshell.app/logs/` |
| Settings (language, retention) | `~/Library/Application Support/com.pyshell.app/settings.json` |
| Secrets | macOS Keychain / Windows Credential Manager |
| Secret index (names only, never values) | `~/Library/Application Support/com.pyshell.app/secrets.json` |
| Bookmarks | `~/Library/Application Support/com.pyshell.app/bookmarks/` |

Run artifacts go to `PYSHELL_OUTPUT_DIR` (passed to the script as an environment
variable), not next to the script. The last 50 runs per script are kept
(configurable in Settings ▸ History & limits, which governs the History list
and the run folders with one number).

## Security

- **Secrets** — in the keychain, passed via env, never via argv
- **Introspection** — executes arbitrary code, so it is gated behind a consent
  dialog; 10s timeout, env without secrets, `PYSHELL_INTROSPECT=1`
- **App Sandbox is off** — scripts have full access to the system; only import
  scripts you trust
- **Dependencies** — `uv pip install -r` with sdist fallback for Python 3.13
- **Script Store** — downloads files from the community repo over HTTPS but
  never executes anything: installing only parses the manifest, and running is
  the same explicit step as for a local script. Repo paths are validated
  (no traversal, ASCII names only) and per-install size caps apply; files land
  in a staging directory and are moved into place only when the download
  completes.

## Releases

CI (`.github/workflows/ci.yml`) runs the checks above on every push to main
and every PR — macOS only. The Windows job was removed after a failing tag
build; the cause is now understood (see Platforms) but not fixed, so it stays
out.

A release is built from a tag:

```bash
# bump the version in package.json, src-tauri/Cargo.toml and tauri.conf.json together
git tag v0.5.1 && git push origin v0.5.1
```

The workflow builds a universal `.dmg` for macOS (arm64 + x86_64 in one file),
then creates a **draft** release — the artifacts have to be checked and
published by hand. No Windows or Linux artifacts are produced (see Platforms).
Before building it necessarily runs `npm run fetch-uv` (sidecar + uv licenses)
and `cargo test` (generates the ts-rs bindings); without those two steps the
build fails before bundling.

Builds are unsigned — see [Installing and first launch](#installing-and-first-launch)
for what users will see. Auto-update (`tauri-plugin-updater`) is deliberately
disabled: the plugin is not registered in `lib.rs`, and the `"active": false`
field in `tauri.conf.json` is a Tauri v1 leftover with no effect.

## License

PyShell is released under the **MIT** license — see [`LICENSE`](LICENSE).

Copyright (c) 2026 Dmytro Lobov

The app bundles the third-party [`uv`](https://github.com/astral-sh/uv) binary
(Astral Software Inc., MIT OR Apache-2.0) as a sidecar. Its licenses are
downloaded by `npm run fetch-uv` into `src-tauri/licenses/uv/` and ship inside
the bundle. The full list of third-party code and MPL-2.0 dependencies is in
[`THIRD-PARTY-LICENSES.md`](THIRD-PARTY-LICENSES.md).

The Python interpreters `uv` downloads at runtime are distributed by their
authors (python-build-standalone / PSF) under their own terms and are not part of
PyShell.
