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
 *   node scripts/fetch-uv.mjs                       # host target
 *   node scripts/fetch-uv.mjs x86_64-apple-darwin   # explicit target
 *   node scripts/fetch-uv.mjs --force               # re-download
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

const isWindows = triple.includes("windows");
const archiveName = `uv-${triple}.${isWindows ? "zip" : "tar.gz"}`;
const baseUrl = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}`;
const dest = join(binariesDir, `uv-${triple}${isWindows ? ".exe" : ""}`);

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

// Licences first, and outside the try below: that block's `finally` cleans a
// temp dir, and the early `process.exit` for an already-present binary would
// skip it.
await fetchLicenses();

if (existsSync(dest) && !force) {
  console.log(
    `✓ ${dest} already present (${(statSync(dest).size / 1e6).toFixed(1)} MB) — pass --force to re-download`,
  );
  process.exit(0);
}

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

  const archivePath = join(work, archiveName);
  writeFileSync(archivePath, archive);
  // bsdtar handles both .tar.gz and .zip, and ships with macOS and Windows 10+.
  execFileSync("tar", ["-xf", archivePath, "-C", work], { stdio: "inherit" });

  const extracted = findBinary(work, isWindows ? "uv.exe" : "uv");
  if (!extracted) throw new Error(`no uv binary inside ${archiveName}`);

  mkdirSync(binariesDir, { recursive: true });
  copyFileSync(extracted, dest);
  if (!isWindows) chmodSync(dest, 0o755);

  console.log(`✓ ${dest} (${(statSync(dest).size / 1e6).toFixed(1)} MB, sha256 verified)`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
