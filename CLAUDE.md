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
These endpoints/flags are added on top of upstream (vanilla IOPaint lacks them). Most back the Lua integration; the last backs a web-UI feature:
- `GET /api/v1/connected_clients` — Socket.IO client count; the Lua script polls this to detect when the browser tab closes (→ auto-import).
- `GET`/`POST /api/v1/presets` + `--preset-file PATH` — UI presets stored as JSON; the Lua script points this at the darktable config dir so they're backed up with darktable's config (not browser localStorage).
- `GET /api/v1/server_log` + `--log-file PATH` — the server reads back the file the launcher redirects stdout/stderr into, for the in-UI log viewer.
- `GET /api/v1/models` + `POST /api/v1/download_model` — back the Models manager UI (list/size/download/switch).
- `POST /api/v1/cancel` — sets a module-level `cancel_requested` event; `diffuser_callback` reads it each step and sets `pipe._interrupt = True` to stop a running diffusion inference early. Backs the progress-bar stop buttons (the frontend also aborts the `fetch`). Erase models run a single forward pass, so cancel is a no-op for them.

### Frontend
React + Vite + Zustand. Global state and most logic live in `web_app/src/lib/states.ts` (a single Zustand store; `settings` and `fileManagerState` are persisted to localStorage via `partialize`, and the in-progress edit session is persisted to IndexedDB — see "Session persistence" below). API calls are in `web_app/src/lib/api.ts`. Custom UI surfaces: header dialogs (`ModelManager`, `PresetSelect`, `LogsDialog`), the diffusion options panel (`SidePanel/DiffusionOptions.tsx`), the workflow tabs (`SidePanel/WorkflowTabs.tsx`), the edit-history `HistoryPanel` (a floating button in the top-left toolbar in `Workspace.tsx`, opening a left sheet beneath it), and `DiffusionProgress` (the centered progress bars + stop buttons). The inpaint request payload is assembled in `api.ts` — note feature params (cropper/extender/hd_strategy/brushnet/etc.) are sent there.

#### Workflow tabs (cropper / extender / patch fill) — fork-specific
The three mutually-exclusive pre-processing workflows are a tab strip at the top of the right `SidePanel` (`SidePanel/WorkflowTabs.tsx`), not separate toggles/floating controls. Tabs: **Whole** (no workflow — disables all three), **Cropper**, **Extender** (only when `model.support_outpainting`), **Patch fill**. The active tab is *derived* from the existing booleans (`settings.patchFill` / `showCropper` / `showExtender`) — there is no separate "active workflow" field — and changing tabs sets them mutually-exclusively via `updateSettings`. Each tab inlines its own controls (cropper preset sizes, extender axis/scale, patch-fill size/overlap/context). The patch-fill number inputs keep a local `draft` and commit on blur (writing to the store mid-keystroke would re-run the tile preview / snap clamped values). Because these tabs now host patch fill (previously a floating button shown for all models), `SidePanel` renders for INPAINT/erase models too — `renderSidePanelOptions()` returns `null` for them so they show *only* the workflow tabs.

#### Layer/history editor model (fork-specific)
The editor replaced upstream's linear undo stack with a toggleable layer model in `editorState`: an ordered `entries: HistoryEntry[]` plus a `headIndex` (entries `< headIndex` are "in the timeline", `>=` are redoable). A `HistoryEntry` is either a `PatchEntry` (a rectangular inpaint result over the current base — toggleable on/off, and carrying the `lineGroup`/`extraMasks` it was made from plus a `settings`/`cropper` snapshot for reuse/reapply) or a `RebaseEntry` (a structural, size-changing op like outpaint or an upscale plugin, whose canvas becomes the new full base). `composeEntries` (in `lib/utils.ts`) renders `originalImage` + the enabled entries up to `headIndex` into the displayed/exported canvas; `getCurrentTargetFile`/`getComposedCanvas` wrap it. The `HistoryPanel` lists entries; each patch/batch card has an identity row (thumbnail, label, expand chevron, enable toggle) plus an always-visible `ActionBar` row of icon actions: "Reuse mask", "Load settings", "Retry" (patches only), "Delete". Enable/disable (`togglePatch`/`setBatchEnabled`) is non-destructive; delete (`deletePatch`/`deleteBatch`) permanently splices the entry/batch out of `entries` and decrements `headIndex` for each removed in-timeline entry (confirmed via an AlertDialog since it isn't undoable). `retryPatch(id)` re-runs a single patch *in place* using its own saved mask + settings (fresh random seed unless the patch fixed its seed): it composites the entries *before* the patch as the input (`composeEntries(entries, idx)` — the base it was applied over), regenerates the mask from the entry's `lineGroup`/`extraMasks`, switches the loaded model to the patch's model if they differ (the server holds one model), then replaces only that entry's `canvas`/`bbox`. It reuses the same `isInpainting`/`currentAbort` machinery as `runInpainting`, so the progress bar + stop button work. Only patches/batches are deletable and only patches are retryable — `RebaseEntry`s are structural (later patches depend on their coordinate space) and stay locked. Types live in `lib/types.ts`.

#### Session persistence / crash recovery (fork-specific)
The in-progress edit session survives a browser reload (so a transient failure is recoverable without redoing work). `lib/session.ts` persists the source `File` plus the committed history (`entries`/`headIndex`) to **IndexedDB** (`iopaint-session` DB, single `current` record) — *not* the localStorage `persist` middleware, because a session (source image + a canvas per patch/rebase) can be tens of MB. Canvases/masks serialize to `Blob`s (IndexedDB stores them natively, no base64). A `WeakMap` blob cache keyed on the canvas/image element skips re-encoding immutable entries on each save (cheap even for a 19-tile batch when only `enabled` toggles).

The record is **keyed to file identity** (`fileName` + `fileSize`). This matters because `setFile` is the app's *normal* load path (FileManager pick → `getMediaFile` → `setFile`, image upload, drag-drop, `/inputimage` URL param) — **not** a "user switched images" signal — so it must not blindly wipe the session. Instead `setFile` restores the persisted edits when the incoming file matches by name+size, and only `clearSession()`s + starts fresh when it's a different image. In `states.ts`: a single debounced (`600ms`) `useStore.subscribe` autosaves on `entries`/`headIndex`/`file` change (it never touches storage while `file` is null — that's the pre-restore mount window, and clearing there would delete the record the restore is about to read). On mount, `App.tsx`'s boot effect `await`s `restoreSession()` (which reconstructs the file from the stored `fileBlob`, repopulates the store, and resolves `true` if it restored anything) **before** the fork's "preload the first input image" step — ordering that matters: that preload always picks `medias[0]`, so running it first would `setFile` a *different* image than the one being edited and clear its session. If a session was restored the preload is skipped entirely. The `isRestoringSession` flag is purely UI (keeps `FileSelect` from flashing before restore resolves). Caveat: the web app never sees the darktable auto-import complete, so a reload right after an import (before picking the next file) briefly auto-restores the prior image.

#### Patch fill / auto-tile (fork-specific)
`runAutoTile` (triggered when `settings.patchFill` is on) covers a large masked area with a sliding window of overlapping tiles processed sequentially, each as its own `PatchEntry` sharing a `batchId` (so undo/redo and the history panel treat the batch as one unit). Per-model-type window defaults (`patchSize`/`patchOverlap`/`patchContextPad`) and the `modelNativeSize` helper live in `lib/const.ts`; the tiling math (`computeTiles`, `featherPatch`, `clipMaskToRect`) is in `lib/utils.ts`. When patch fill is off, oversized images on a diffusion model auto-enable and size the cropper to the model's native resolution (`maybeAutoEnableCropper`).

### The darktable script ([darktable/iopaint.lua](darktable/iopaint.lua))
Registers a lib module + shortcuts. Reads preferences (namespace `iopaint`: `port`, `iopaint_repo`, `model`, `device` enum, `result_suffix`, `extra_args`, `disconnect_debounce`). Auto-detects its own repo via `debug.getinfo`, runs the server from the repo's `.venv`, uses fixed temp dirs under the OS temp dir (`<tmp>/iopaint_dt/{input,output}`, `iopaint.log`), and builds the start command (passing `--input/--output-dir/--model/--device/--preset-file/--log-file`). It monitors the connected-clients endpoint to auto-import results after a debounce. `install.sh`/`install.ps1` install a thin shim into darktable's `lua/contrib/` that `dofile`s the real script from the checkout.

## Pitfalls

- Python support is 3.9–3.14; `requirements.txt` relaxes some upstream pins (e.g. Pillow) so newer Python works. `iopaint/helper.py` reimplements the stdlib `imghdr` (removed in 3.13) via Pillow.
- BrushNet and PowerPaint v2 require a **non-inpaint** SD1.5 base; nearly all curated diffusion models are inpaint variants, so those toggles are correctly hidden for them.
- When verifying server changes, prefer a throwaway port (e.g. 8419) and kill it after (`lsof -ti tcp:8419 | xargs kill`) rather than disturbing the user's running instances.
