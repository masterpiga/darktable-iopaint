# darktable → IOPaint integration

A [darktable](https://www.darktable.org/) Lua script that drives [IOPaint](https://github.com/Sanster/IOPaint)
to inpaint/clean up selected images and bring the results back into your library, group them with the originals, and copy over rating, color labels and tags.

It includes a modified version of IOPaint to smooth the integration with darktable.

See the original [IOPaint](https://github.com/Sanster/IOPaint) repository for the base code and for the documentation of IOPaint.

Co-authored with Claude and Gemini.

## Important notice

> ⚠️ **Experimental software — use at your own risk.** The lua script starts background
> processes, exports/imports files next to your originals, and modifies the darktable
> database. It comes with **no warranty** (see the License). Back up your work first.
> It has been **tested only on macOS**; the Linux and Windows paths are provided as-is and
> may not work.


## Demo

https://github.com/user-attachments/assets/37acc48b-426d-48a3-9ce7-6a32db68d66d

## What it does

1. **Send selection to IOPaint** — exports the selected images (current image in darkroom)
   as PNG into a temporary folder, starts a persistent IOPaint server pointed at that folder
   (and a temporary output folder), and opens the IOPaint UI in your browser. A progress bar
   in darktable's *background jobs* panel shows the model loading / UI starting up.
2. The first image loads automatically. Edit it and press **Ctrl+S** to save; auto-saving
   writes the result to the output folder using the same filename. For additional images, use
   the **file browser** (folder icon in the top bar) to switch between them.
3. When you **close the browser tab**, the script automatically scans the output folder,
   copies each result next to its original (with a configurable suffix), imports it into the
   darktable database, copies the original's **rating, color labels and tags**, and **groups
   the result with the original** (the original stays the group leader) so they stack together.
4. In addition to that flat PNG, the script drops a **duplicate of the original that keeps its
   full darktable edit history**, with the result composited back on top via the **overlay**
   module. This is the useful one: you get a still-editable raw (all your modules intact) with
   the retouch layered in, instead of only a baked PNG. The overlay is forced to run last, just
   before the output colour profile, because the result was exported already tone-mapped and
   must not be reprocessed. It's best-effort — if darktable's module order or the overlay
   parameters can't be synthesised, the PNG import still succeeds and the reason is logged.

You can also trigger **Import IOPaint results** manually at any time (fallback if the
automatic tab-close detection misses).

A **stop IOPaint server** button (enabled only while the server is running) shuts the
managed server down.

The module appears in the right panel in lighttable and the left panel in darkroom. Three
shortcuts (*IOPaint: send selection* / *IOPaint: import results* / *IOPaint: stop server*)
can be bound under `settings > shortcuts > lua`.

## Quick install (recommended)

**Prerequisites:**
* `darktable` with Lua Api >= `7.0.0`
* `node`/`npm`
* Python 3.9–3.14.

One command clones this fork, builds it (virtualenv + dependencies + web frontend),
wires the script into darktable, and (optionally) pre-downloads the model.

If the script completes successfully, you just need to
restart darktable, enable the script in the Lua script
editor and you are good to go.

**macOS / Linux**

```bash
curl -fsSL https://raw.githubusercontent.com/masterpiga/darktable-iopaint/main/install.sh | bash
```

**Windows (PowerShell)**

```powershell
irm https://raw.githubusercontent.com/masterpiga/darktable-iopaint/main/install.ps1 | iex
```

The script will ask you where to install and where your darktable config directory is located (sensible defaults are offered)

On next launch, enable **iopaint** (under `contrib`) in the **lua scripts** panel — the **IOPaint**
module then appears in lighttable and darkroom.

## Manual setup

If you prefer to set things up by hand instead (or for whatever reason the quick install script does not work for you):

1. Clone this fork and run the setup script. It creates a virtualenv (`.venv` in the
   checkout), installs IOPaint (this fork) into it, and builds the web frontend:

   ```bash
   git clone https://github.com/masterpiga/darktable-iopaint darktable-iopaint
   cd darktable-iopaint
   ./darktable/setup.sh
   ```

   `setup.sh` picks a supported Python (3.9–3.14; override with `PYTHON=/path/to/python3`)
   and prints the **source checkout** path to set in the preferences below.

2. Quit darktable if running already.

3. `$ cp darktable-iopaint/darktable/iopaint.lua ~/.config/darktable/lua/contrib/iopaint.lua`

  Replace `~/.config` with your actual darktable config dir path.

4. Run darktable.

5. In the lua scripts panel, navigate to `contrib` and activate the
   `iopaint` script.

6. Open darktable's preferences (`settings`) → Lua options, and
   selection `iopaint` from the dropdown.

7. Set the **source checkout** preference to the path of the cloned repo.

The script runs the server from the checkout's `.venv` automatically. (`setup.sh`
already built the frontend; the script will rebuild it on first launch only if it's missing, e.g. if you skipped `setup.sh`.)


## Configuration

Under `settings > lua options` (namespace **iopaint**):

| Preference | Default | Notes |
| --- | --- | --- |
| server port | `8418` | Port for the dedicated IOPaint instance this script runs. Keep it distinct from any IOPaint you run manually (don't use 8080). |
| **source checkout (this fork)** | *(empty)* | Path to where you cloned the repository. **Set this** — it's the only launch setting. The server is run from the checkout's `.venv` (created by `setup.sh`); the frontend, also built by `setup.sh`, is rebuilt on first launch only if missing. |
| model | `lama` | Default model to load at launch. You can also **switch and download** models from the IOPaint UI (the *Models* button), so this is just the starting model. |
| device | `cpu` | Compute device: `cpu` (works everywhere), `mps` (Apple Silicon GPU), or `cuda` (NVIDIA GPU). A GPU is strongly recommended for diffusion models. |
| result suffix | `_iopaint` | Appended to the imported filename before the extension. |
| extra server arguments | *(empty)* | Appended verbatim to `iopaint start` (advanced). |
| disconnect debounce (seconds) | `2` | How long the browser must stay closed before importing (absorbs page reloads / blips). Lower = imports sooner. |

Images are exported as 8-bit PNG: IOPaint and the inpainting models work in 8-bit RGB
throughout (input is converted to 8-bit on load, the browser editor composites on an 8-bit
canvas, and diffusion models operate in a normalized latent space and reconstruct to 8-bit),
so a deeper export would just be downconverted with no quality gain.

### Choosing a model

The `model` preference accepts any model IOPaint supports. They fall into two families:

- **Erase models** (`lama`, `migan`, `mat`, `fcf`, `zits`, …) remove the masked area with no
  prompt. They're fast and need no GPU. **`lama` is the best general choice** here — the others
  are usually lower-fidelity on photographic content. Erase models excel at removing larger
  objects/distractors against structured backgrounds; on smooth gradients (sky, skin, bokeh)
  they can smear, and they don't reproduce grain, so a clean fix can "pop" against grainy
  surroundings.
- **Diffusion models** (e.g. `runwayml/stable-diffusion-inpainting`,
  `Uminosachi/realisticVisionV51_v51VAE-inpainting`, or an SDXL inpaint model) synthesize
  plausible texture *and* grain, which handles gradients and skin far better. They are heavier:
  several GB to download, much slower, and they want a GPU — set the **device** preference to
  `mps` (Apple Silicon) or `cuda` (NVIDIA), otherwise inference runs on CPU and is very slow.
  In the UI they expose a prompt, *strength* (lower = stays closer to the original),
  *mask blur*, steps and guidance. For subtle retouching, low strength + a little mask blur
  blends a fix in seamlessly. **BrushNet** and **PowerPaint V2** (with the `context-aware` or
  `object-remove` task) are diffusion variants tuned to respect the original pixels — good for
  prompt-free, grain-aware fills.

For fine **creases/dust on smooth or grainy areas**, darktable's own **retouch** module (heal
mode + wavelet scales) is often better than any inpaint model, because it copies *real*
neighbouring grain instead of synthesizing it. A hybrid works well: IOPaint for the heavy
removal, retouch for grain-matched cleanup.

> **Note on models:** model weights are licensed separately from this code and are downloaded
> at runtime under their own terms. The default **lama** is Apache-2.0. Other models IOPaint
> can fetch may be more restrictive — e.g. the RemoveBG model `briaai/RMBG-1.4` is for
> **non-commercial use only**, and many diffusion checkpoints are community/OpenRAIL-licensed.
> Check the license of any model you enable before relying on it.

## The web UI

Beyond stock IOPaint, the editor this fork ships adds presets, the workflow tabs, patch fill,
a layer-style edit history, stop buttons and crash recovery. The rest of this section covers
those.

### Presets

The IOPaint UI has a **Presets** dropdown (bookmark icon, top-right). *Save current as preset…*
snapshots the **full settings, including the model**; selecting a preset reapplies them (and
switches the running server's model if it differs). Presets are stored as JSON in your
**darktable config dir** (`<config>/iopaint_presets.json`), so they persist across sessions and
get backed up with the rest of your darktable config. Note a preset is a per-session override:
the next *send* still launches the server with the `model` preference above.

### Workflows (whole / cropper / extender / patch fill)

The top of the right-hand panel is a **tab strip** picking how the image is fed to the model.
The tabs are mutually exclusive and each one carries its own controls:

- **Whole** — no pre-processing; the full image goes to the model.
- **Cropper** — restrict inpainting to a region, processed at (near) native resolution, with
  **512 / 768 / 1024** quick-size buttons. This is the big quality/speed win for diffusion
  models on high-resolution photos, since it avoids the server downscaling the whole frame.
  For oversized images on a diffusion model the cropper is turned on and sized automatically.
- **Extender** — outpainting (only shown for models that support it); pick the axis and scale.
- **Patch fill** — see below.

### Patch fill (auto-tiling)

Diffusion models only see ~512px (SDXL ~1024px) at a time, so a *large* masked area either has
to be downscaled (mush) or done by hand tile by tile. **Patch fill** does it for you: it covers
the masked region with a sliding window of **overlapping tiles**, runs them one at a time at
native resolution, and feather-blends the seams. Each tile is fed the already-filled neighbours
as context, so the fill stays coherent across the whole area.

Three controls (with per-model-type defaults — 512/128/32 for SD-class models, 1024/256/64 for
SDXL):

| Control | Meaning |
| --- | --- |
| **Patch size** | Tile size sent to the model; keep at the model's native resolution. |
| **Overlap** | How much neighbouring tiles overlap. Must be more than 2 × context, so the *inpainted* interiors overlap and can be blended. |
| **Context** | Padding of already-known pixels around each tile, giving the model something to match. |

A progress bar shows *tile n of N* while the batch runs. The whole run lands in the history as
a **single collapsible batch** you can toggle or delete as one unit.

### Edit history

The **Edit history** button (top-left of the canvas) opens a panel listing every edit as a
separate, **toggleable layer** — this replaces upstream's linear undo stack. Each inpaint is a
patch over the region it covers, so you can switch individual results **on and off** to compare
them, instead of undoing everything after them.

Each card carries a thumbnail, an **enable/disable** switch, a chevron that expands the exact
**settings the result was made with** (model, prompt, steps, guidance, strength, sampler, mask
blur, seed), plus a row of actions:

| Action | What it does |
| --- | --- |
| **Reuse mask** | Loads that patch's mask back into the editor (without running), so you can re-run it — e.g. on a different model — and compare. |
| **Load settings** | Applies the saved settings, switching the server's model if needed. Doesn't run, so you can tweak first. |
| **Retry** | Re-runs that patch **in place** with its own mask and settings, giving a fresh result (a new random seed, unless the patch pinned one). Only the patch's own pixels change; later edits are untouched. |
| **Delete** | Permanently removes the edit from the history (asks first — unlike the toggle, this can't be undone). |

Structural, size-changing steps (outpainting, upscaling) become locked entries: later patches
are positioned relative to them, so they can't be toggled or deleted.

### Stopping a run

Diffusion inference can take a while on CPU. Both progress bars (single inference and patch
fill) have a **stop** button that interrupts the run at the next diffusion step and, for patch
fill, stops before starting the next tile. Erase models like `lama` do a single forward pass,
so there's nothing to interrupt there.

### Crash recovery

The in-progress session — the source image plus the whole edit history — is saved to the
browser's IndexedDB as you work. If the tab crashes or you reload, everything is restored
automatically, so a transient failure doesn't cost you the work. Opening a *different* image
starts a fresh session.

### Managing models from the UI

The **Models** button (top-right) opens a manager listing the erase and diffusion models, each
with its **download status** and **size** (actual on-disk when downloaded, otherwise an estimate
prefixed with `~`). From here you can **Download** a model, **Use** an already-downloaded one
(switches the running server, no restart), or download **any HuggingFace model id** via the
field at the bottom. This means you no longer need to pick the model on the command line — the
`model` preference is only the model loaded at launch.

### Server logs

The **Server logs** button (top-right) shows the tail of the server's output (stdout + stderr),
which is the quickest way to debug a model that fails to load or download. The darktable script
passes `--log-file` so the server can read back the same file it logs to
(`<tmp>/iopaint_dt/iopaint.log`).

## How it works (and limitations)

- The script manages **its own IOPaint instance** on a dedicated port (default **8418**),
  separate from any IOPaint you launch by hand. If a *different* IOPaint is already running on
  that port (one started without `--input`/`--output-dir`, so no file browser or auto-save),
  the script refuses rather than opening an empty UI — stop it or pick another port. Don't set
  the port to one your manual IOPaint uses (e.g. 8080).
- The IOPaint server is started **once** with fixed temporary input/output folders under your
  system temp dir (`<tmp>/iopaint_dt/`), and reused across runs. IOPaint's input/output dirs
  are fixed at startup, so the script reuses the same dirs and clears them at the start of each
  send.
- **One editing session at a time.** Because the folders are shared and cleared per send,
  sending a new selection while a session is open in the browser is refused.
- If you drop a new selection while the IOPaint tab is already open, **refresh the file
  browser** in IOPaint to see the new files.
- Result filenames use the source image's database id as a prefix inside the temp folders to
  avoid collisions between identically-named files from different folders; the final imported
  file uses `<original name><suffix>.png`.
- Changing the **port** or **model** preference only takes effect after the running IOPaint
  server is stopped.
- Automatic import relies on detecting the browser disconnect (with debounce). If it ever
  misfires, use **Import IOPaint results** before closing the tab.

## The IOPaint side

This fork adds a few small server features:

- `GET /api/v1/connected_clients` → `{"count": N}` — number of currently connected web
  clients (tracked via the existing Socket.IO connection the UI already opens). This is what
  lets the script notice when you close the browser tab. **Vanilla IOPaint does not have
  it**: against a vanilla server the script detects this, skips the auto-import, and tells you
  to use *Import IOPaint results* manually.
- `GET` / `POST /api/v1/presets` — read and write the UI's presets as JSON, plus a new
  `--preset-file PATH` option on `iopaint start` telling the server where to store them. The
  darktable script points this at `<config>/iopaint_presets.json` so presets live in (and are
  backed up with) your darktable config rather than browser localStorage.
- `GET /api/v1/models` — the known erase/diffusion models with download status and size; and
  `POST /api/v1/download_model` (`{"name": …}`) to fetch one. These back the *Models* manager UI.
- `GET /api/v1/server_log` — the tail of the server log, plus a new `--log-file PATH` option so
  the server knows which file (written by the launcher's redirection) to read back. Backs the
  *Server logs* viewer.
- `POST /api/v1/cancel` — asks a running diffusion inference to stop at its next step (the
  frontend also aborts the request). Backs the progress bars' *stop* buttons. Erase models run
  a single forward pass, so this is a no-op for them.

The `--input` / `--output-dir` options (which enable the file browser and Ctrl+S
auto-saving) are standard IOPaint features and are set automatically by this script.

The frontend is substantially reworked on top of upstream's: the layer-style **edit history**
(replacing the linear undo stack), the **workflow tabs**, **patch fill**, the **Models** and
**Presets** dialogs, the **server log** viewer, the progress-bar **stop** buttons, and
IndexedDB **session persistence** are all additions of this fork.

A couple of small upstream fixes are also included: the HD **Crop** strategy parameters
(crop trigger size / margin) were misspelled in the inpaint request and silently ignored —
now corrected and the crop margin widened, which reduces seams/smearing from erase models on
high-resolution images. Model-type detection was also fixed for community diffusion checkpoints
that misreport themselves in `model_index.json` (it now checks the UNet's input channels), which
otherwise silently offered incompatible options that crashed at inference.

The frontend build step is `scripts/build_frontend.sh` (`npm run build` in `web_app/`, copied
into `iopaint/web_app/`). `setup.sh` runs it during setup; the darktable script also runs it on
first launch as a fallback if the build is missing.

## License

This repository combines two parts under different licenses:

- The **upstream IOPaint** code (the `iopaint/` package, `web_app/`, `setup.py`, etc.),
  including modifications made here, remains under the **Apache License 2.0** — see
  [`LICENSE`](LICENSE). Modified upstream files (notably `iopaint/api.py`) are noted in
  [`NOTICE`](NOTICE) per Apache-2.0 §4.
- The **darktable integration** added by this project — `darktable/iopaint.lua`,
  `darktable/setup.sh`, `scripts/build_frontend.sh`, `install.sh`, `install.ps1` — is licensed
  under the **GNU General Public License v3.0 or later** (to match darktable) — see
  [`darktable/LICENSE`](darktable/LICENSE). Each file carries an SPDX header.

Model weights are licensed separately and under their own terms (see the note above).

This is a summary, not legal advice.
