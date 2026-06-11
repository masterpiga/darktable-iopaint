# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A **fork of IOPaint** that adds a **darktable Lua integration** for inpainting. Two cooperating pieces:

- **IOPaint** — a FastAPI inpainting server (`iopaint/`) plus a React/Vite web UI (`web_app/`). Upstream code, Apache-2.0.
- **darktable integration** — `darktable/iopaint.lua` (a darktable Lua script) plus `install.sh`/`install.ps1`/`darktable/setup.sh`. GPL-3.0-or-later (to match darktable).

The Lua script launches and manages its own IOPaint server, exports selected images, opens the browser UI, then imports the edited results back into the darktable library (copying rating/labels/tags and grouping with the original).

## License split (matters when editing)

Files under `iopaint/`, `web_app/`, `setup.py` are **Apache-2.0**. Files in `darktable/` plus `scripts/build_frontend.sh`, `install.sh`, `install.ps1` are **GPL-3.0-or-later** and carry SPDX headers. When you modify an upstream (Apache) file in a fork-specific way, record it in [`NOTICE`](NOTICE) (Apache-2.0 §4 requires listing modified files).

## Commands

Always use the project virtualenv (`.venv/bin/python`), never the system Python — IDE diagnostics resolve against system Python 3.14 and produce false "cannot find module" errors for `torch`, `fastapi`, etc.

```bash
# One-time setup: creates .venv, pip install -e ., builds the frontend
./darktable/setup.sh                 # or: PYTHON=/path/to/python3 ./darktable/setup.sh

# Run the server the way the Lua script does (adjust dirs/port/model/device)
.venv/bin/python -m iopaint start --host 127.0.0.1 --port 8418 --model lama \
  --device cpu --input <in_dir> --output-dir <out_dir>

# Python tests (need the venv + downloaded model weights; many hit real models)
.venv/bin/python -m pytest iopaint/tests/
.venv/bin/python -m pytest iopaint/tests/test_model.py::test_lama   # single test

# Frontend (run from web_app/)
cd web_app && npm run dev          # dev server; set VITE_BACKEND to a running IOPaint (see api.ts)
cd web_app && npx tsc --noEmit     # typecheck (do this after any .ts/.tsx change)
cd web_app && npm run lint         # eslint, --max-warnings 0

# Build the frontend into iopaint/web_app/ (what the server actually serves)
./scripts/build_frontend.sh

# Lua syntax check
luac -p darktable/iopaint.lua
```

## Critical build/run workflow

- **The served frontend is a build artifact.** `iopaint/web_app/` is gitignored. The server serves that prebuilt bundle; `web_app/src` changes do nothing until you run `./scripts/build_frontend.sh` (which does `npm run build` in `web_app/` and copies `dist/` → `iopaint/web_app/`).
- **The managed server is long-lived.** After changing server code *or* rebuilding the frontend, the running IOPaint instance keeps serving the old code/bundle. Stop it (the Lua module's "stop server" button, or `lsof -ti tcp:<port> | xargs kill`) and re-trigger a send so a fresh server starts.
- Lua/server changes also require restarting the managed server to take effect.

## Architecture

### Server request flow
`main.py` → `iopaint/__init__.py:entry_point` → `iopaint/cli.py` (Typer `start` command, builds an `ApiConfig`) → `iopaint/api.py` (`Api` class registers all `/api/v1/...` routes and mounts the static frontend + a Socket.IO server at `/ws`) → `iopaint/model_manager.py` (`ModelManager.init_model`/`switch`/`__call__`) → `iopaint/model/*` (one module per model). Plugins live in `iopaint/plugins/`, the input/output file browser in `iopaint/file_manager/`.

### Model typing drives the UI
`iopaint/schema.py:ModelInfo` has `@computed_field` `support_*` properties (`support_brushnet`, `support_powerpaint_v2`, `support_controlnet`, `support_strength`, …) keyed off `model_type` (`ModelType` enum: `DIFFUSERS_SD`, `DIFFUSERS_SD_INPAINT`, `DIFFUSERS_SDXL[_INPAINT]`, `INPAINT`, …). The frontend shows/hides feature toggles based on these flags, and `ModelManager.init_model` gates which wrapper class is instantiated. **Model type is detected in `iopaint/download.py:scan_models`** — note that some community inpaint models lie in `model_index.json` (`_class_name: StableDiffusionPipeline` while the UNet is 9-channel), so type detection also checks the UNet `in_channels` (9 = inpaint, 4 = regular). Getting `model_type` wrong silently offers incompatible features (e.g. BrushNet/PowerPaint require a plain 4-channel SD1.5 base) that then crash with channel-mismatch errors at inference.

### Fork-specific server additions
These endpoints/flags are added on top of upstream and are what the Lua integration depends on (vanilla IOPaint lacks them):
- `GET /api/v1/connected_clients` — Socket.IO client count; the Lua script polls this to detect when the browser tab closes (→ auto-import).
- `GET`/`POST /api/v1/presets` + `--preset-file PATH` — UI presets stored as JSON; the Lua script points this at the darktable config dir so they're backed up with darktable's config (not browser localStorage).
- `GET /api/v1/server_log` + `--log-file PATH` — the server reads back the file the launcher redirects stdout/stderr into, for the in-UI log viewer.
- `GET /api/v1/models` + `POST /api/v1/download_model` — back the Models manager UI (list/size/download/switch).

### Frontend
React + Vite + Zustand. Global state and most logic live in `web_app/src/lib/states.ts` (a single Zustand store; `settings` and `fileManagerState` are persisted to localStorage via `partialize`). API calls are in `web_app/src/lib/api.ts`. Header dialogs (`ModelManager`, `PresetSelect`, `LogsDialog`) and the diffusion options panel (`SidePanel/DiffusionOptions.tsx`) are the main custom UI surfaces. The inpaint request payload is assembled in `api.ts` — note feature params (cropper/extender/hd_strategy/brushnet/etc.) are sent there.

### The darktable script ([darktable/iopaint.lua](darktable/iopaint.lua))
Registers a lib module + shortcuts. Reads preferences (namespace `iopaint`: `port`, `iopaint_repo`, `model`, `device` enum, `result_suffix`, `extra_args`, `disconnect_debounce`). Auto-detects its own repo via `debug.getinfo`, runs the server from the repo's `.venv`, uses fixed temp dirs under the OS temp dir (`<tmp>/iopaint_dt/{input,output}`, `iopaint.log`), and builds the start command (passing `--input/--output-dir/--model/--device/--preset-file/--log-file`). It monitors the connected-clients endpoint to auto-import results after a debounce. `install.sh`/`install.ps1` install a thin shim into darktable's `lua/contrib/` that `dofile`s the real script from the checkout.

## Pitfalls

- Python support is 3.9–3.14; `requirements.txt` relaxes some upstream pins (e.g. Pillow) so newer Python works. `iopaint/helper.py` reimplements the stdlib `imghdr` (removed in 3.13) via Pillow.
- BrushNet and PowerPaint v2 require a **non-inpaint** SD1.5 base; nearly all curated diffusion models are inpaint variants, so those toggles are correctly hidden for them.
- When verifying server changes, prefer a throwaway port (e.g. 8419) and kill it after (`lsof -ti tcp:8419 | xargs kill`) rather than disturbing the user's running instances.
