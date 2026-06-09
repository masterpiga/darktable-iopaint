#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Daniele Pighin
#
# One-step setup for the darktable -> IOPaint integration.
#
# Creates a Python virtualenv, installs IOPaint (this fork) into it, and builds
# the web frontend. After it finishes, set the two printed values in darktable's
# lua preferences (settings > lua options, namespace "iopaint").
#
# Usage:
#   darktable/setup.sh [venv_dir]      # default venv_dir = <repo>/.venv
#   PYTHON=/path/to/python3 darktable/setup.sh
#
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VENV_DIR="${1:-$REPO_ROOT/.venv}"

# IOPaint pins old dependencies (e.g. Pillow==9.5.0) that only ship wheels for
# Python 3.8-3.11; newer interpreters try to build from source and fail. Pick a
# supported interpreter rather than whatever `python3` happens to be.
pyver() { "$1" -c 'import sys;print("%d.%d"%sys.version_info[:2])' 2>/dev/null; }
# Supported range: 3.9-3.14 (some pinned deps lack wheels for very new Pythons).
supported_version() { case "$1" in 3.9|3.10|3.11|3.12|3.13|3.14) return 0;; *) return 1;; esac; }

pick_python() {
  if [ -n "${PYTHON:-}" ]; then
    command -v "$PYTHON" >/dev/null 2>&1 || { echo "error: PYTHON='$PYTHON' not found on PATH." >&2; return 1; }
    if ! supported_version "$(pyver "$PYTHON")"; then
      echo "error: PYTHON='$PYTHON' is Python $(pyver "$PYTHON"); IOPaint needs 3.9-3.14." >&2; return 1
    fi
    echo "$PYTHON"; return 0
  fi
  # prefer the plain 'python3' if it's in range, then newest-to-oldest
  for cand in python3 python3.14 python3.13 python3.12 python3.11 python3.10 python3.9; do
    if command -v "$cand" >/dev/null 2>&1 && supported_version "$(pyver "$cand")"; then
      echo "$cand"; return 0
    fi
  done
  echo "error: no supported Python found (need 3.9-3.14)." >&2
  echo "       Install one (e.g. 'brew install python@3.12') or set PYTHON=/path/to/python3." >&2
  return 1
}

PYTHON="$(pick_python)" || exit 1

echo "Repository : $REPO_ROOT"
echo "Virtualenv : $VENV_DIR"
echo "Python     : $PYTHON (Python $(pyver "$PYTHON"))"
echo

# 1. virtualenv (recreate if an existing one uses an unsupported Python)
if [ -d "$VENV_DIR" ]; then
  existing="$VENV_DIR/bin/python"
  [ -x "$existing" ] || existing="$VENV_DIR/Scripts/python.exe"
  if [ ! -x "$existing" ] || ! supported_version "$(pyver "$existing")"; then
    echo "Existing virtualenv uses an unsupported Python ($(pyver "$existing" 2>/dev/null || echo unknown)); recreating..."
    rm -rf "$VENV_DIR"
  fi
fi
if [ ! -d "$VENV_DIR" ]; then
  echo "Creating virtualenv..."
  "$PYTHON" -m venv "$VENV_DIR"
fi
VENV_PY="$VENV_DIR/bin/python"
[ -x "$VENV_PY" ] || VENV_PY="$VENV_DIR/Scripts/python.exe"  # Windows (git-bash)

# 2. make sure pip exists in the venv. On Debian/Ubuntu the venv is often created
# without pip because ensurepip's bundled wheels live in a separate apt package
# (pythonX.Y-venv). Bootstrap it via ensurepip, then get-pip.py, before using it.
if ! "$VENV_PY" -m pip --version >/dev/null 2>&1; then
  echo "pip not found in the virtualenv; bootstrapping..."
  "$VENV_PY" -m ensurepip --upgrade >/dev/null 2>&1 || true
fi
if ! "$VENV_PY" -m pip --version >/dev/null 2>&1; then
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL https://bootstrap.pypa.io/get-pip.py | "$VENV_PY" - >/dev/null 2>&1 || true
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- https://bootstrap.pypa.io/get-pip.py | "$VENV_PY" - >/dev/null 2>&1 || true
  fi
fi
if ! "$VENV_PY" -m pip --version >/dev/null 2>&1; then
  echo "error: pip is unavailable in $VENV_DIR and could not be bootstrapped." >&2
  echo "       On Debian/Ubuntu, install the venv package and retry:" >&2
  echo "         sudo apt install python3-venv python$(pyver "$VENV_PY")-venv" >&2
  echo "       then delete '$VENV_DIR' and run this again." >&2
  exit 1
fi

# 3. dependencies (this can take a while - it pulls torch etc.)
echo "Upgrading pip..."
"$VENV_PY" -m pip install --upgrade pip >/dev/null
echo "Installing IOPaint (this fork) and its dependencies..."
"$VENV_PY" -m pip install -e "$REPO_ROOT"

# 4. frontend
if command -v npm >/dev/null 2>&1; then
  echo "Building web frontend..."
  "$REPO_ROOT/scripts/build_frontend.sh"
else
  echo "warning: npm not found - skipping frontend build. It will be built automatically"
  echo "         on first run, or run scripts/build_frontend.sh later once npm is installed."
fi

echo
echo "Done. In darktable, set this lua preference (settings > lua options, 'iopaint'):"
echo "  source checkout (this fork) : $REPO_ROOT"
