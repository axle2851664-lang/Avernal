#!/bin/sh
# Portable launcher. Anchors every path to this script's own directory, so the
# app finds its vault, tokens and model weights wherever the drive is mounted
# and whatever letter or mount point the host gives it.
set -e

DIR=$(cd "$(dirname "$0")" && pwd)
cd "$DIR"

# Node and Python are NOT bundled -- they must exist on the host machine.
# Bundling them would mean a separate ~200MB runtime per operating system.
for cmd in node python3; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Helix needs $cmd on this machine, and it is not installed." >&2
    echo "Install it, then run this script again." >&2
    exit 1
  fi
done

export HELIX_DATA="$DIR"
mkdir -p "$DIR/models" "$DIR/vault"

if [ ! -d node_modules ]; then
  echo "First run on this machine: installing dependencies..."
  npm ci --legacy-peer-deps
fi

echo "Helix data root: $DIR"
exec npm run server
