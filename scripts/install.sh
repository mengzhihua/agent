#!/usr/bin/env bash
# One-click install for macOS and Linux.
# Prefers the latest GitHub Release tarball (compiled dist, Node 22 only).
#   curl -fsSL https://raw.githubusercontent.com/mengzhihua/agent/main/scripts/install.sh | bash
# Source from main instead: AGENT_REF=main bash install.sh
set -euo pipefail

REPO="${AGENT_REPO:-mengzhihua/agent}"
REF="${AGENT_REF:-latest}"
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

NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])")"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "Node.js 22+ is required (found $(node -v))." >&2
  exit 1
fi

if [ "${1:-}" = "--uninstall" ]; then
  if [ -f "$SRC/scripts/setup.mjs" ]; then
    node "$SRC/scripts/setup.mjs" --prefix "$PREFIX" --from "$SRC" --uninstall
  else
    rm -rf "$PREFIX/src" "$PREFIX/bin/agent" "$HOME/.local/bin/agent" "$HOME/.agent/env.sh"
    echo "Removed $PREFIX shims."
  fi
  exit 0
fi

download_archive() {
  local dest="$1"
  if [ "$REF" = "main" ] || [ "$REF" = "master" ]; then
    echo "Downloading $REPO@$REF source ..."
    curl -fsSL "https://github.com/$REPO/archive/refs/heads/${REF}.tar.gz" -o "$dest"
    return
  fi
  if [ "$REF" = "latest" ]; then
    echo "Downloading latest GitHub Release ..."
    if curl -fsSL "https://github.com/$REPO/releases/latest/download/agent.tgz" -o "$dest"; then
      return
    fi
    echo "No release asset yet; installing from main source." >&2
    curl -fsSL "https://github.com/$REPO/archive/refs/heads/main.tar.gz" -o "$dest"
    return
  fi
  echo "Downloading $REPO@$REF ..."
  curl -fsSL "https://github.com/$REPO/releases/download/${REF}/agent.tgz" -o "$dest" \
    || curl -fsSL "https://github.com/$REPO/releases/download/v${REF#v}/agent.tgz" -o "$dest" \
    || curl -fsSL "https://github.com/$REPO/archive/refs/tags/${REF}.tar.gz" -o "$dest" \
    || curl -fsSL "https://github.com/$REPO/archive/refs/heads/${REF}.tar.gz" -o "$dest"
}

mkdir -p "$PREFIX"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/agent-install.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

download_archive "$TMP/src.tgz"
tar -xzf "$TMP/src.tgz" -C "$TMP"
EXTRACT="$(find "$TMP" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
rm -rf "$SRC"
mkdir -p "$(dirname "$SRC")"
mv "$EXTRACT" "$SRC"

SETUP=(node "$SRC/scripts/setup.mjs" --from "$SRC" --prefix "$PREFIX")
if [ -f "$SRC/dist/cli.js" ]; then
  SETUP+=(--skip-build)
else
  need npm
fi
"${SETUP[@]}"
echo
echo "macOS / Linux install complete. Open a new terminal so PATH picks up ~/.local/bin."
