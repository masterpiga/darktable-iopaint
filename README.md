# darktable → IOPaint integration

A [darktable](https://www.darktable.org/) Lua script that drives [IOPaint](https://github.com/Sanster/IOPaint)
to inpaint/clean up selected images and bring the results back into your library, group them with the originals, and copy over rating, color labels and tags.

It includes a modified version of IOPaint to smooth the integration with darktable.

See the original [IOPaint](https://github.com/Sanster/IOPaint) repository for the base code and for the documentation of IOPaint.

Co-authored with Claude and Gemini.

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
* A Python version between 3.8 and 3.11.

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

   `setup.sh` picks a supported Python (3.8–3.11; override with `PYTHON=/path/to/python3.11`)
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
| model | `lama` | IOPaint model to load. |
| result suffix | `_iopaint` | Appended to the imported filename before the extension. |
| extra server arguments | *(empty)* | Appended verbatim to `iopaint start` (advanced, e.g. `--device cuda`). |
| disconnect debounce (seconds) | `8` | How long the browser must stay closed before importing (absorbs page reloads / blips). |

Images are exported as 8-bit PNG: IOPaint and the LaMa model work in 8-bit RGB throughout
(input is converted to 8-bit on load, and the browser editor composites on an 8-bit canvas),
so a deeper export would just be downconverted with no quality gain.

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

This fork adds one small server endpoint:

- `GET /api/v1/connected_clients` → `{"count": N}` — number of currently connected web
  clients (tracked via the existing Socket.IO connection the UI already opens). This is what
  lets the script notice when you close the browser tab. **Vanilla IOPaint does not have
  it**: against a vanilla server the script detects this, skips the auto-import, and tells you
  to use *Import IOPaint results* manually.

The `--input` / `--output-dir` options (which enable the file browser and Ctrl+S
auto-saving) are standard IOPaint features and are set automatically by this script.

The frontend build step is `scripts/build_frontend.sh` (`npm run build` in `web_app/`, copied
into `iopaint/web_app/`). `setup.sh` runs it during setup; the darktable script also runs it on
first launch as a fallback if the build is missing.
