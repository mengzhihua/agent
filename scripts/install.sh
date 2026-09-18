#!/usr/bin/env bash
# One-click install for macOS and Linux.
#   curl -fsSL https://raw.githubusercontent.com/mengzhihua/agent/main/scripts/install.sh | bash
set -euo pipefail

REPO="${AGENT_REPO:-mengzhihua/agent}"
REF="${AGENT_REF:-main}"
PREFIX="${AGENT_PREFIX:-$HOME/.agent}"
SRC="$PREFIX/src"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing $1. Install it and re-run." >&2
    exit 1
  }
}

need curl
need tar
need node
need npm

NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])")"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "Node.js 22+ is required (found $(node -v))." >&2
  exit 1
fi

if [ "${1:-}" = "--uninstall" ]; then
  if [ -f "$SRC/scripts/setup.mjs" ]; then
    node "$SRC/scripts/setup.mjs" --prefix "$PREFIX" --uninstall
  else
    rm -rf "$PREFIX/src" "$PREFIX/bin/agent" "$HOME/.local/bin/agent"
    echo "Removed $PREFIX shims."
  fi
  exit 0
fi

mkdir -p "$PREFIX"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/agent-install.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

echo "Downloading $REPO@$REF ..."
curl -fsSL "https://github.com/$REPO/archive/refs/heads/${REF}.tar.gz" -o "$TMP/src.tgz" \
  || curl -fsSL "https://github.com/$REPO/archive/refs/tags/${REF}.tar.gz" -o "$TMP/src.tgz"
tar -xzf "$TMP/src.tgz" -C "$TMP"
EXTRACT="$(find "$TMP" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
rm -rf "$SRC"
mkdir -p "$(dirname "$SRC")"
mv "$EXTRACT" "$SRC"

node "$SRC/scripts/setup.mjs" --from "$SRC" --prefix "$PREFIX"
echo
echo "macOS / Linux install complete. Open a new terminal if PATH was updated."
