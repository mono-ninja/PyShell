/**
 * The in-app scripting guide, shown by Help → How to Write a Script.
 *
 * Kept as Markdown and rendered through `renderMarkdown`, the same subset
 * renderer used for script READMEs — so the guide is styled like every other
 * document in the app and needs no bespoke markup.
 *
 * This is the English counterpart of the (unpublished) `docs/scripting.md`.
 * Keep the two in step when the manifest or event protocol changes.
 */
export const SCRIPTING_GUIDE = `# Writing a PyShell script

A PyShell script is an ordinary Python program. PyShell only needs to know
**what inputs it takes** and **how to pass them** — that is what a manifest
describes. It then renders a form, builds the command line, runs the script in
its own virtual environment, and streams the output back.

Nothing here is required to *run* a script: a plain \`.py\` with an
\`argparse\` parser already works. The manifest is how you get good labels,
validation, secrets and grouped fields.

## Project layout

A folder project is the fullest form:

\`\`\`
my-script/
├── pyshell.yaml          manifest
├── main.py               entry point
├── requirements.txt      dependencies (optional)
└── docs/
    ├── pyshell.md        operator page
    └── pyshell_ua.md     translation (optional)
\`\`\`

A single \`.py\` file works too — put the manifest inline (PEP 723) or rely on
introspection.

## Three ways to describe a script

1. **\`pyshell.yaml\`** beside the script — the fullest form.
2. **PEP 723 inline manifest** — a TOML block in comments at the top of a \`.py\`.
3. **Introspection** — no manifest; PyShell reads the script's
   \`argparse\`/\`click\`/\`typer\` definition to guess a schema.

Resolution order is exactly that: \`pyshell.yaml\` wins over an inline manifest,
which wins over introspection.

## The manifest

\`\`\`yaml
schema: 1
id: com.example.my-script
name: My Script
description: What this script does
icon: lucide:wrench
category: Tools

runtime:
  entry: main.py
  python: ">=3.11,<3.14"
  requirements: requirements.txt
  timeout: 60

inputs:
  - key: url
    type: url
    label: URL
    help: Address to check
    required: true
    binding:
      kind: arg
      flag: "--url"
      style: space

outputs:
  artifacts:
    - "*.csv"
  result: table
\`\`\`

**Top level**

| Key | Required | Meaning |
|---|---|---|
| \`schema\` | yes | Always \`1\` |
| \`name\` | yes | Display name |
| \`runtime\` | yes | How to run it |
| \`inputs\` | yes | Form fields; may be an empty list |
| \`id\` | no | Unique id; derived from the path when absent |
| \`description\`, \`icon\`, \`category\` | no | Presentation |
| \`outputs\` | no | Artifacts and result kind |

\`icon\` accepts either a bare emoji (\`icon: 🔧\`) or a vector icon by name,
\`icon: lucide:<name>\` — e.g. \`lucide:rocket\`, \`lucide:database\`,
\`lucide:terminal\`. An unknown or missing name falls back to plain text, so
existing emoji manifests keep working unchanged.

**\`runtime\`**

| Key | Required | Meaning |
|---|---|---|
| \`entry\` | yes | Path to the \`.py\`, relative to the manifest |
| \`python\` | yes | PEP 440 constraint, e.g. \`">=3.11,<3.14"\` |
| \`requirements\` | no | Path to \`requirements.txt\` |
| \`timeout\` | no | Seconds; omit for no limit |

## The same thing inline (PEP 723)

\`\`\`python
#!/usr/bin/env python3
# /// script
# [tool.pyshell]
# id = "com.example.my-script"
# name = "My Script"
# python = ">=3.11"
#
# [[tool.pyshell.inputs]]
# key = "url"
# type = "url"
# label = "URL"
# required = true
# [tool.pyshell.inputs.binding]
# kind = "arg"
# flag = "--url"
# style = "space"
# ///
\`\`\`

## Introspection

With no manifest, PyShell can derive a schema by monkey-patching \`argparse\`,
\`click\` and \`typer\`. It detects flags, types (\`str\`, \`int\`, \`float\`, \`bool\`,
\`choices\`), defaults, help text and positional arguments.

It **executes the module**, so it sits behind a consent dialog. It also runs
with a 10-second timeout, and \`os.fork\`, \`subprocess.Popen\` and \`time.sleep\`
are blocked so a script with a long loop cannot hang the app.

\`PYSHELL_INTROSPECT=1\` is set while this happens — guard anything expensive:

\`\`\`python
import os, sys

if os.environ.get("PYSHELL_INTROSPECT") == "1":
    sys.exit(0)   # let PyShell read the parser, skip the real work
\`\`\`

Keep the parser at module level or inside a \`main()\` guarded by
\`if __name__ == "__main__":\`. Press **Save Manifest** afterwards to freeze the
result into a \`pyshell.yaml\`.

## Field types

| \`type\` | Renders as | Extra keys |
|---|---|---|
| \`string\` | text input | \`pattern\`, \`max_len\` |
| \`multiline\` | textarea | — |
| \`int\` | number | \`min\`, \`max\` |
| \`float\` | number | \`min\`, \`max\` |
| \`bool\` | checkbox | — |
| \`choice\` | dropdown | \`options\` |
| \`multi_choice\` | multi-select | \`options\` |
| \`file\` | file picker | \`extensions\` |
| \`files\` | multi-file picker | \`extensions\` |
| \`dir\` | folder picker | — |
| \`save_path\` | save dialog | \`default_name\` |
| \`secret\` | password (keychain) | — |
| \`date\` | date picker | — |
| \`url\` | URL input | — |

Common to all: \`key\`, \`label\`, \`help\`, \`default\`, \`required\`, \`group\`,
\`visible_if\`, \`binding\`.

## Bindings — how a value reaches the script

| \`kind\` | Effect |
|---|---|
| \`arg\` | Command-line flag |
| \`env\` | Environment variable (\`name:\`) |
| \`positional\` | Positional argument |
| \`stdin\` | Written to standard input |
| \`temp_file\` | Written to a temp file; the path is passed |

\`temp_file\` is the right choice for \`multiline\` — a long text is awkward and
fragile on a command line.

For \`kind: arg\`, \`style\` decides the shape:

| \`style\` | Result |
|---|---|
| \`space\` | \`--url VALUE\` |
| \`equals\` | \`--url=VALUE\` |
| \`flag\` | \`--verbose\` (bool, emitted only when true) |
| \`repeat\` | \`--tag a --tag b\` |
| \`joined\` | \`--tags a,b\` (needs \`sep\`) |

\`\`\`yaml
- key: tags
  type: multi_choice
  options: [{value: a}, {value: b}]
  binding: {kind: arg, flag: "--tag", style: repeat}
# → main.py --tag a --tag b
\`\`\`

Press ⇧⌘P before running to see the exact command PyShell will execute.

## Conditional fields

\`\`\`yaml
- key: mode
  type: choice
  options: [{value: simple}, {value: advanced}]
  default: simple
  binding: {kind: arg, flag: "--mode", style: space}

- key: batch_size
  type: int
  label: Batch Size
  visible_if: {op: eq, key: mode, value: advanced}
  binding: {kind: arg, flag: "--batch-size", style: space}
\`\`\`

Operators: \`eq\` (equals), \`ne\` (not equals), \`truthy\` (non-empty / true /
non-zero). A hidden field contributes nothing to the command line.

## Grouping

Give fields the same \`group\` and they render as one collapsible section:

\`\`\`yaml
- key: url
  type: url
  group: Connection
  binding: {kind: arg, flag: "--url", style: space}

- key: timeout
  type: int
  group: Connection
  default: 30
  binding: {kind: arg, flag: "--timeout", style: space}
\`\`\`

## Secrets

\`\`\`yaml
- key: api_key
  type: secret
  label: API Key
  required: true
  binding:
    kind: env
    name: API_KEY
\`\`\`

\`\`\`python
api_key = os.environ.get("API_KEY")
\`\`\`

The value is stored in the macOS Keychain / Windows Credential Manager. It never
returns to the interface, and never reaches \`state.json\`, history or logs.

**A secret may only bind to \`env\`.** \`argv\` is readable by every process on the
machine, so \`arg\`, \`positional\` and \`temp_file\` are rejected when the manifest
is validated — this is enforced, not advice.

## Reporting progress

Print JSON to **stderr** with \`"pyshell": true\` and PyShell renders it as native
UI instead of a log line. The discriminator matters: without it, a script that
logs \`{"error": "..."}\` would have that line silently swallowed.

\`\`\`python
import json, sys

def emit(event):
    event["pyshell"] = True
    print(json.dumps(event), file=sys.stderr, flush=True)

emit({"type": "progress", "pct": 42.5, "message": "Scanning"})
emit({"type": "status", "message": "Phase 2 of 3"})
emit({"type": "table", "columns": ["Host", "Status"], "rows": [["a.com", "OK"]]})
emit({"type": "markdown", "content": "## Done\\n\\nFound **3** items."})
emit({
    "type": "chart",
    "chart_type": "line",
    "title": "Latency",
    "labels": ["1", "2", "3"],
    "series": [{"name": "ms", "values": [12, 40, 9]}],
})
\`\`\`

### Rules

- Events go to **stderr**; ordinary \`print()\` goes to stdout and shows in Output.
- \`"pyshell": true\` is mandatory.
- **One event per line.** \`json.dumps(..., indent=2)\` breaks parsing — the
  multi-line JSON falls apart into unrelated log lines.
- \`flush=True\` is required. PyShell sets \`PYTHONUNBUFFERED=1\` as well, but do
  not rely on that alone.
- \`pct\` is **0–100, not 0–1**. Sending \`0.42\` pins the bar near zero.
- Each kind **replaces** its previous value rather than appending.
- An unknown \`type\` is ignored silently — if nothing appears, check the spelling.
- Throttle them: events are sent individually without batching, and they count
  toward the same output cap as log lines (50 MB / 500k lines per run).
- Do not use \`rich\` or \`tqdm\` for progress — PyShell uses pipes, not a PTY, so
  anything redrawing in place will not work. SGR colour codes *are* rendered.

A throttling helper worth copying:

\`\`\`python
def progress_reporter(total):
    """Emit at most one event per whole percent."""
    last = -1

    def report(done, message=""):
        nonlocal last
        pct = int(done * 100 / total) if total else 0
        if pct != last:
            last = pct
            emit({"type": "progress", "pct": pct, "message": message})

    return report
\`\`\`

## Files and results

Write artifacts to \`PYSHELL_OUTPUT_DIR\` and declare them as globs — they appear
in **Results** as cards with *Show* and *Save*.

\`\`\`yaml
outputs:
  artifacts:
    - "*.csv"
    - "output/*.json"
  result: table      # table | markdown | none
\`\`\`

\`\`\`python
import os

out = os.environ.get("PYSHELL_OUTPUT_DIR", ".")
with open(os.path.join(out, "results.csv"), "w") as f:
    f.write("name,value\\nalpha,1\\n")
\`\`\`

\`result\` only tells the interface what to expect before the first run; a script
may emit anything regardless.

## Environment

| Variable | Meaning |
|---|---|
| \`PYSHELL_OUTPUT_DIR\` | Where to write artifacts |
| \`PYSHELL_INTROSPECT\` | \`1\` while the schema is being introspected |
| *your \`env\` bindings* | Field values, including secrets |

## Dependencies

Put a \`requirements.txt\` beside the script and point \`runtime.requirements\` at
it. Press **Prepare Env**: PyShell shows the list, asks for confirmation, then
installs into a virtual environment belonging to that script alone. Editing the
file changes the environment key, which marks the env stale and rebuilds it on
the next run.

## Documenting it for the operator

Put a Markdown file beside the script and PyShell shows it in the **Docs** panel
(⌘D). Most specific wins: \`<script-name>.md\`, then \`pyshell.md\`, then
\`README.md\`. A README addresses whoever clones the repository; \`pyshell.md\`
addresses whoever is about to press Run — what the fields mean, what it will
touch, how to read the result.

PyShell looks in a **\`docs/\`** subfolder first and only falls back to the
script's own directory when that holds no document, so \`docs/pyshell.md\` is the
recommended home for a project's page.

Add translations with a language suffix — \`pyshell_ua.md\` next to
\`pyshell.md\` — and the panel grows a language picker. The unsuffixed file is
the default. Only variants of the *same* document are offered together, so a
\`README.md\` never appears as a "language" of \`pyshell.md\`.

The renderer is a CommonMark subset: headings, lists, code, tables, links,
emphasis. HTML is never executed, images are not shown, and the file is capped
at 512 KB.

## A complete example

\`\`\`python
#!/usr/bin/env python3
import json, os, sys, argparse

def emit(event):
    event["pyshell"] = True
    print(json.dumps(event), file=sys.stderr, flush=True)

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--url", required=True)
    p.add_argument("--depth", type=int, default=10)
    args = p.parse_args()

    if os.environ.get("PYSHELL_INTROSPECT") == "1":
        sys.exit(0)

    token = os.environ.get("API_KEY")   # from a secret field
    out = os.environ.get("PYSHELL_OUTPUT_DIR", ".")

    rows = []
    for i in range(args.depth):
        emit({"type": "progress", "pct": int(i * 100 / args.depth)})
        rows.append([f"{args.url}/{i}", "OK"])

    with open(os.path.join(out, "report.csv"), "w") as f:
        for url, status in rows:
            f.write(f"{url},{status}\\n")

    emit({"type": "table", "columns": ["URL", "Status"], "rows": rows})
    emit({"type": "progress", "pct": 100, "message": "Done"})
    print("Finished", flush=True)

if __name__ == "__main__":
    main()
\`\`\`
`;
