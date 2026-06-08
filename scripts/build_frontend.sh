#!/usr/bin/env bash
#
# Build the IOPaint web frontend and copy it into iopaint/web_app.
#
# The server serves its UI from iopaint/web_app, but that directory is generated
# (it is gitignored) - a fresh checkout only contains the frontend *source* in
# web_app/. Run this once after cloning so the server can be started directly
# from the checkout (e.g. by the darktable integration in darktable/iopaint.lua).
#
# Requires Node.js / npm.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$REPO_ROOT/web_app"

if [ ! -d node_modules ]; then
  echo "Installing web_app dependencies (npm install)..."
  npm install
fi

echo "Building frontend (npm run build)..."
rm -rf dist
npm run build

echo "Copying build into iopaint/web_app..."
rm -rf "$REPO_ROOT/iopaint/web_app"
cp -r dist "$REPO_ROOT/iopaint/web_app"

echo "Done. Frontend built into $REPO_ROOT/iopaint/web_app"
