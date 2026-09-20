#!/usr/bin/env bash
# One-click install for macOS and Linux.
# Prefers a native GitHub Release binary (no Node.js). Falls back to agent.tgz + Node 22.
#   curl -fsSL https://raw.githubusercontent.com/mengzhihua/agent/main/scripts/install.sh | bash
# Source from main instead: AGENT_REF=main bash install.sh
set -euo pipefail

REPO="${AGENT_REPO:-mengzhihua/agent}"
REF="${AGENT_REF:-latest}"
PREFIX="${AGENT_PREFIX:-$HOME/.agent}"
SRC="$PREFIX/src"
BIN_DIR="$PREFIX/bin"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing $1. Install it and re-run." >&2
    exit 1
  }
}

native_id() {
  local os arch
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"
  case "$os" in
    linux) os="linux" ;;
    darwin) os="darwin" ;;
    *) return 1 ;;
  esac
  case "$arch" in
    x86_64|amd64) arch="x64" ;;
    aarch64|arm64) arch="arm64" ;;
    *) return 1 ;;
  esac
  printf '%s-%s' "$os" "$arch"
}

write_unix_path() {
  local bin_dir="$1"
  local env_file="$HOME/.agent/env.sh"
  mkdir -p "$(dirname "$env_file")" "$bin_dir"
  printf '%s\nexport PATH="%s:$PATH"\n' "# agent PATH" "$bin_dir" > "$env_file"
  local snippet="# agent PATH
[ -f \"$env_file\" ] && . \"$env_file\""
  for name in .profile .bashrc .zshrc .zprofile; do
    local rc="$HOME/$name"
    if [ "$name" != ".profile" ] && [ ! -f "$rc" ]; then
      continue
    fi
    if [ -f "$rc" ] && grep -q "# agent PATH" "$rc"; then
      continue
    fi
    printf '\n%s\n' "$snippet" >> "$rc"
  done
  mkdir -p "$HOME/.local/bin"
  ln -sf "$bin_dir/agent" "$HOME/.local/bin/agent" 2>/dev/null || cp "$bin_dir/agent" "$HOME/.local/bin/agent"
}

if [ "${1:-}" = "--uninstall" ]; then
  if [ -f "$SRC/scripts/setup.mjs" ] && command -v node >/dev/null 2>&1; then
    node "$SRC/scripts/setup.mjs" --prefix "$PREFIX" --from "$SRC" --uninstall
  else
    rm -rf "$SRC" "$BIN_DIR/agent" "$HOME/.local/bin/agent" "$HOME/.agent/env.sh"
    echo "Removed $PREFIX shims."
  fi
  exit 0
fi

need curl

release_download() {
  local asset="$1"
  local dest="$2"
  if [ "$REF" = "latest" ]; then
    curl -fsSL "https://github.com/$REPO/releases/latest/download/$asset" -o "$dest"
    return
  fi
  curl -fsSL "https://github.com/$REPO/releases/download/${REF}/$asset" -o "$dest" \
    || curl -fsSL "https://github.com/$REPO/releases/download/v${REF#v}/$asset" -o "$dest"
}

install_native() {
  if [ "$REF" = "main" ] || [ "$REF" = "master" ]; then
    return 1
  fi
  local id
  id="$(native_id)" || return 1
  need tar
  local tmp
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/agent-native.XXXXXX")"
  if ! release_download "agent-${id}.tar.gz" "$tmp/agent.tgz"; then
    rm -rf "$tmp"
    return 1
  fi
  tar -xzf "$tmp/agent.tgz" -C "$tmp"
  local bin
  bin="$(find "$tmp" -type f \( -name agent -o -name "agent-${id}" \) | head -n 1)"
  if [ -z "$bin" ]; then
    rm -rf "$tmp"
    return 1
  fi
  mkdir -p "$BIN_DIR"
  cp "$bin" "$BIN_DIR/agent"
  chmod +x "$BIN_DIR/agent"
  write_unix_path "$BIN_DIR"
  rm -rf "$tmp"
  echo "Installed native $BIN_DIR/agent ($id)"
  echo "Open a new terminal so PATH picks up ~/.local/bin, then run: agent doctor"
  return 0
}

if install_native; then
  exit 0
fi

echo "Native binary not used; installing the Node 22 tarball (or source)." >&2
need tar
need node

NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])")"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "Node.js 22+ is required (found $(node -v))." >&2
  exit 1
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
