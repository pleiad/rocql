#!/usr/bin/env bash
#
# Build a multiplatform .vsix for the Rocq Graph extension that is accepted by
# Open VSX (https://open-vsx.org).
#
# Two things make this non-trivial:
#
#  1. Multiplatform binaries.
#     `frogql` is a napi-rs native module. `npm install` only pulls the
#     optionalDependency matching the BUILD host's os/cpu, so every other
#     platform's binary must be injected by hand or the extension throws on
#     require('frogql') and registers no commands. We fat-pack ALL platform
#     packages into the vsix so a single artifact works everywhere.
#
#  2. Open VSX rejects zip "extra fields".
#     Open VSX blocks any vsix whose zip entries carry extra-field records
#     ("extension file contains zip entries with potentially harmful extra
#     fields"). Both `vsce` (via yazl -> 0x5455 timestamp field) and a plain
#     `zip -r` (0x5455 + 0x7875 uid/gid) add them. The final repackaging step
#     below uses `zip -X -D`, which writes ZERO extra-field bytes.
#
# Usage:  bash scripts/package-openvsx.sh
# Output: vscode-extension/<name>-<version>-multiplatform.vsix
#
set -euo pipefail

# --- paths -------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"   # the vscode-extension directory
cd "$EXT_DIR"

# All platforms frogql ships prebuilt binaries for (its optionalDependencies).
# If frogql adds/removes a target, update this list to match.
PLATFORM_PKGS=(
  frogql-darwin-arm64
  frogql-darwin-x64
  frogql-linux-arm64-gnu
  frogql-linux-x64-gnu
  frogql-win32-x64-msvc
)

# --- 0. tooling sanity -------------------------------------------------------
for t in node npm npx unzip zip tar; do
  command -v "$t" >/dev/null 2>&1 || { echo "ERROR: '$t' not found on PATH" >&2; exit 1; }
done

# --- 1. dependencies + compile ----------------------------------------------
echo "==> Installing dependencies"
npm install

echo "==> Compiling TypeScript"
npx tsc -p .

# --- 2. identity & versions (derived, never hard-coded) ----------------------
NAME=$(node -p "require('./package.json').name")
VERSION=$(node -p "require('./package.json').version")
FROGQL_VERSION=$(node -p "require('./node_modules/frogql/package.json').version")
BASENAME="${NAME}-${VERSION}"
BASE_VSIX="${EXT_DIR}/${BASENAME}.vsix"
OUT_VSIX="${EXT_DIR}/${BASENAME}-multiplatform.vsix"
echo "==> Packaging ${BASENAME} with frogql@${FROGQL_VERSION} (all platforms)"

# --- 3. base vsix (host binary only) ----------------------------------------
# `zip` appends to an existing archive, so remove stale outputs first.
rm -f "$BASE_VSIX" "$OUT_VSIX"
npx --yes @vscode/vsce package --allow-missing-repository -o "$BASE_VSIX"

# --- 4. fetch every platform binary at the SAME frogql version ---------------
echo "==> Fetching platform binaries for frogql@${FROGQL_VERSION}"
BIN_CACHE="$(mktemp -d)"
( cd "$BIN_CACHE"
  for p in "${PLATFORM_PKGS[@]}"; do
    echo "    - ${p}@${FROGQL_VERSION}"
    npm pack "${p}@${FROGQL_VERSION}" >/dev/null
  done )

# --- 5. fat-pack: inject all platform binaries into the unpacked vsix ---------
echo "==> Injecting platform binaries"
WORK="$(mktemp -d)"
unzip -q "$BASE_VSIX" -d "$WORK/unpacked"
for p in "${PLATFORM_PKGS[@]}"; do
  dest="$WORK/unpacked/extension/node_modules/${p}"
  mkdir -p "$dest"
  tar xzf "$BIN_CACHE/${p}-${FROGQL_VERSION}.tgz" -C "$dest" --strip-components=1
done

# --- 5b. patch frogql's napi-rs loader (musl detection) ----------------------
# frogql's loader (<= 0.2.3) does `process.report.getReport().header` with no
# guard. In the VS Code extension host getReport() can return undefined, so
# activation crashes with "Cannot read properties of undefined (reading
# 'header')" and no commands register. Make it null-safe and default to glibc
# (musl=false) — we only inject the *-gnu Linux binaries, so a wrong musl=true
# would fail the require anyway. Idempotent; a no-op on already-safe loaders
# (>= 0.2.8 guard it themselves).
echo "==> Patching frogql loader (null-safe musl detection)"
node - "$WORK/unpacked/extension/node_modules/frogql/index.js" <<'PATCH'
const fs = require('fs');
const file = process.argv[2];
let s = fs.readFileSync(file, 'utf8');
const MARK = '/* openvsx-multiplatform: musl detection made null-safe */';
if (s.includes(MARK)) { console.log('    already patched (no-op)'); process.exit(0); }
const vulnerable = 'const { glibcVersionRuntime } = process.report.getReport().header\n    return !glibcVersionRuntime';
const safe = MARK + '\n' +
  '    const __report = process.report.getReport()\n' +
  '    return !!(__report && __report.header) && !__report.header.glibcVersionRuntime';
if (s.includes(vulnerable)) {
  fs.writeFileSync(file, s.replace(vulnerable, safe));
  console.log('    patched 0.2.3-style loader');
} else {
  console.log('    vulnerable pattern not found — assuming already-safe loader, skipping');
}
PATCH

# --- 6. repackage WITHOUT zip extra fields (the Open VSX fix) -----------------
echo "==> Repackaging as Open VSX-safe vsix"
#   -X  do not store extra file attributes (drops 0x5455 / 0x7875 extra fields)
#   -D  do not create entries for directories
#   -r  recurse;  run from inside unpacked/ so [Content_Types].xml,
#       extension.vsixmanifest and extension/ sit at the archive root.
( cd "$WORK/unpacked" && zip -qr -X -D "$OUT_VSIX" . )

# --- 7. verify no extra fields remain ---------------------------------------
echo "==> Verifying zip is clean"
EXTRA_BYTES=$(python3 - "$OUT_VSIX" <<'PY'
import zipfile, sys
print(sum(len(i.extra) for i in zipfile.ZipFile(sys.argv[1]).infolist()))
PY
)
if [ "$EXTRA_BYTES" != "0" ]; then
  echo "ERROR: vsix still has ${EXTRA_BYTES} bytes of zip extra fields — Open VSX will reject it." >&2
  exit 1
fi

# --- 8. cleanup temp dirs ----------------------------------------------------
rm -rf "$BIN_CACHE" "$WORK"

echo
echo "OK  -> ${OUT_VSIX}"
echo "     total zip extra-field bytes: 0 (Open VSX safe)"
echo "     bundled platforms: ${PLATFORM_PKGS[*]}"
echo
echo "Publish with:"
echo "    npx ovsx publish \"${OUT_VSIX}\" -p <YOUR_OPEN_VSX_TOKEN>"
