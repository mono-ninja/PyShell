#!/usr/bin/env node
/**
 * Downloads the `uv` sidecar into src-tauri/binaries/.
 *
 * The binary is not committed: it is ~40 MB per target, three targets are
 * needed for a release, and every version bump would keep the old copies in
 * git history forever.
 *
 * It is not optional, either — `tauri_build` copies every `externalBin` in
 * build.rs, so a missing file fails `cargo check` with
 * "resource path `binaries/uv-<triple>` doesn't exist", long before bundling.
 *
 * Usage:
 *   node scripts/fetch-uv.mjs                            # host target
 *   node scripts/fetch-uv.mjs x86_64-apple-darwin        # explicit target
 *   node scripts/fetch-uv.mjs universal-apple-darwin     # both macOS slices, lipo'd
 *   node scripts/fetch-uv.mjs --force                    # re-download
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Pinned on purpose: the sidecar is part of the build, so bump it knowingly. */
const UV_VERSION = "0.12.5";

const HOST_TRIPLES = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "win32-x64": "x86_64-pc-windows-msvc",
  "win32-arm64": "aarch64-pc-windows-msvc",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
};

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const binariesDir = join(root, "src-tauri", "binaries");

const args = process.argv.slice(2);
const force = args.includes("--force");
const triple =
  args.find((a) => !a.startsWith("--")) ?? HOST_TRIPLES[`${process.platform}-${process.arch}`];

if (!triple) {
  console.error(
    `Unsupported host ${process.platform}-${process.arch}. Pass a target triple explicitly.`,
  );
  process.exit(1);
}

/**
 * macOS universal is a *synthetic* target: astral-sh publishes no such archive,
 * and `tauri build --target universal-apple-darwin` does not lipo external
 * binaries itself — it looks for `binaries/uv-universal-apple-darwin` and fails
 * the bundle if it is missing. So both arch slices are fetched and merged here.
 */
const UNIVERSAL = "universal-apple-darwin";
const UNIVERSAL_SLICES = ["aarch64-apple-darwin", "x86_64-apple-darwin"];

const baseUrl = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}`;

/** Path of the sidecar Tauri will look for, for a given target triple. */
const destFor = (t) => join(binariesDir, `uv-${t}${t.includes("windows") ? ".exe" : ""}`);
const dest = destFor(triple);

/**
 * uv is MIT OR Apache-2.0, and we ship its binary inside every bundle. Both
 * licences require the notice to travel with the copy, but the release archive
 * contains only `uv` and `uvx` — no licence text — so fetch it from the repo at
 * the same pinned tag. `tauri.conf.json` bundles this directory as a resource;
 * dropping it would ship someone else's MIT code with no attribution.
 */
const licenseDir = join(root, "src-tauri", "licenses", "uv");
const UV_LICENSE_FILES = ["LICENSE-MIT", "LICENSE-APACHE"];
const rawBase = `https://raw.githubusercontent.com/astral-sh/uv/${UV_VERSION}`;


async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** The archive holds `uv-<triple>/uv` plus `uvx`; find the one we ship. */
function findBinary(dir, wanted) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      const hit = findBinary(path, wanted);
      if (hit) return hit;
    } else if (name === wanted) {
      return path;
    }
  }
  return null;
}

/**
 * Unpack `archiveName` inside `work`.
 *
 * uv ships .tar.gz for Unix and **.zip for Windows**, so the extractor has to
 * read both. That means bsdtar (libarchive) — and on Windows the bare name
 * `tar` cannot be trusted to be it: under Git Bash, which is the shell the
 * release workflow uses, `tar` resolves to GNU tar, which
 *
 *   - cannot read a zip at all ("This does not look like a tar archive"), and
 *   - treats an absolute `C:\…` path as a remote `host:path`
 *     ("Cannot connect to C: resolve failed").
 *
 * System32's `tar.exe` *is* bsdtar (Windows 10 1803+), so address it by full
 * path rather than through PATH, and pass only the basename with the work
 * directory as cwd so no drive-letter colon reaches the command line at all.
 * PowerShell's Expand-Archive is the fallback for a Windows without bsdtar.
 */
function extract(archiveName, work) {
  if (process.platform !== "win32") {
    // macOS tar is bsdtar and reads both formats, which is also what makes
    // cross-fetching the Windows zip from a Mac work.
    execFileSync("tar", ["-xf", archiveName], { cwd: work, stdio: "inherit" });
    return;
  }

  const bsdtar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  if (existsSync(bsdtar)) {
    execFileSync(bsdtar, ["-xf", archiveName], { cwd: work, stdio: "inherit" });
    return;
  }

  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Expand-Archive -LiteralPath '${archiveName}' -DestinationPath '.' -Force`,
    ],
    { cwd: work, stdio: "inherit" },
  );
}

/** Fetch uv's licence texts next to the binary we redistribute. */
async function fetchLicenses() {
  mkdirSync(licenseDir, { recursive: true });
  for (const name of UV_LICENSE_FILES) {
    const target = join(licenseDir, name);
    if (existsSync(target) && !force) continue;
    writeFileSync(target, await download(`${rawBase}/${name}`));
    console.log(`✓ ${target}`);
  }
}

/** Download, verify and install the sidecar for one real target triple. */
async function fetchSidecar(target) {
  const out = destFor(target);
  if (existsSync(out) && !force) {
    console.log(
      `✓ ${out} already present (${(statSync(out).size / 1e6).toFixed(1)} MB) — pass --force to re-download`,
    );
    return out;
  }

  const win = target.includes("windows");
  const archiveName = `uv-${target}.${win ? "zip" : "tar.gz"}`;
  const work = mkdtempSync(join(tmpdir(), "pyshell-uv-"));
  try {
    console.log(`Downloading ${archiveName} (uv ${UV_VERSION})…`);
    const [archive, checksumFile] = await Promise.all([
      download(`${baseUrl}/${archiveName}`),
      download(`${baseUrl}/${archiveName}.sha256`),
    ]);

    const expected = checksumFile.toString("utf8").trim().split(/\s+/)[0];
    const actual = createHash("sha256").update(archive).digest("hex");
    if (expected !== actual) {
      throw new Error(
        `checksum mismatch for ${archiveName}\n  expected ${expected}\n  got      ${actual}`,
      );
    }

    writeFileSync(join(work, archiveName), archive);
    extract(archiveName, work);

    const extracted = findBinary(work, win ? "uv.exe" : "uv");
    if (!extracted) throw new Error(`no uv binary inside ${archiveName}`);

    mkdirSync(binariesDir, { recursive: true });
    copyFileSync(extracted, out);
    if (!win) chmodSync(out, 0o755);

    console.log(`✓ ${out} (${(statSync(out).size / 1e6).toFixed(1)} MB, sha256 verified)`);
    return out;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// Licences first: they ship beside whichever slice we end up with, and the
// early return for an already-present binary must not skip them.
await fetchLicenses();

if (triple === UNIVERSAL) {
  // `lipo` refuses to merge a file into itself, so build the fat binary from
  // the two thin ones and leave those in place — they cost nothing and a
  // per-arch build still works without re-downloading.
  const slices = [];
  for (const slice of UNIVERSAL_SLICES) slices.push(await fetchSidecar(slice));
  execFileSync("lipo", ["-create", "-output", dest, ...slices], { stdio: "inherit" });
  chmodSync(dest, 0o755);
  const arches = execFileSync("lipo", ["-archs", dest]).toString().trim();
  console.log(`✓ ${dest} (${(statSync(dest).size / 1e6).toFixed(1)} MB, ${arches})`);
} else {
  await fetchSidecar(triple);
}
