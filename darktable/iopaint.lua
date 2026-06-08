--[[
  iopaint.lua - drive IOPaint (https://github.com/Sanster/IOPaint) from darktable.

  Select images in the lighttable (or use the current darkroom image), send them to a
  persistent IOPaint server, edit/inpaint them in the browser, and have the results
  copied back next to the originals with rating, color labels and tags carried over.

  Workflow
    1. "Send selection to IOPaint"
         - exports the selected images as PNG into a temporary input folder
         - starts the IOPaint server (if not already running) pointed at that folder
           and at a temporary output folder
         - opens the IOPaint UI in your browser
         - then watches the browser session: when you close the tab it automatically
           imports whatever you saved.
    2. In IOPaint: edit each image and press Ctrl+S (auto-save writes it to the output
       folder using the same filename). Close the tab when done.
    3. "Import IOPaint results" can be triggered manually at any time as a fallback
       (e.g. if the automatic detection misses the disconnect).

  Requirements
    - IOPaint installed and runnable (see the "launch command" preference).
    - curl on PATH (used for the health / session checks; present on Linux, macOS and
      Windows 10+).

  Install
    - Load via the darktable script_manager, or copy/symlink into
      ~/.config/darktable/lua/ and add `require "iopaint"` to ~/.config/darktable/luarc.
    - Configure preferences under settings > lua options (namespace "iopaint").
]]

local dt = require "darktable"
local du = require "lib/dtutils"
local df = require "lib/dtutils.file"
local dtsys = require "lib/dtutils.system"

du.check_min_api_version("7.0.0", "iopaint")

local MODULE = "iopaint"
local OS = dt.configuration.running_os
local PS = OS == "windows" and "\\" or "/"

-- simple no-op translation wrapper (keeps strings greppable / future-proof)
local function _(s) return s end

-- Absolute path of the repository this script lives in (…/<repo>/darktable/iopaint.lua).
-- Used as the default "source checkout" so a normal install needs no manual configuration.
local function detect_repo()
  local src = debug.getinfo(1, "S").source
  if src:sub(1, 1) == "@" then src = src:sub(2) end
  local dir = src:match("^(.*)[/\\][^/\\]+$")    -- .../<repo>/darktable
  if not dir then return "" end
  return dir:match("^(.*)[/\\][^/\\]+$") or ""   -- .../<repo>
end
local DETECTED_REPO = detect_repo()

-- ---------------------------------------------------------------------------
-- preferences
-- ---------------------------------------------------------------------------

local PREF_TYPES = {
  port = "integer",
  iopaint_repo = "string",
  model = "string",
  result_suffix = "string",
  extra_args = "string",
  disconnect_debounce = "integer",
}

dt.preferences.register(MODULE, "port", "integer",
  _("IOPaint: server port"),
  _("port for the IOPaint server this script manages. 0 = auto-select a free port (default); "
    .."set a specific port if you need one. Keep it distinct from any IOPaint you run manually."),
  0, 0, 65535)
dt.preferences.register(MODULE, "iopaint_repo", "string",
  _("IOPaint: source checkout (this fork)"),
  _("path to a clone of this patched IOPaint fork. Leave empty to auto-detect the folder this "
    .."script lives in. The server runs from its virtualenv (.venv) - run darktable/setup.sh "
    .."once to create it."), "")
dt.preferences.register(MODULE, "model", "string",
  _("IOPaint: model"),
  _("model to load, e.g. lama"), "lama")
dt.preferences.register(MODULE, "result_suffix", "string",
  _("IOPaint: result suffix"),
  _("suffix appended to the imported file name (before the extension)"), "_iopaint")
dt.preferences.register(MODULE, "extra_args", "string",
  _("IOPaint: extra server arguments"),
  _("extra arguments appended to 'iopaint start' (advanced)"), "")
dt.preferences.register(MODULE, "disconnect_debounce", "integer",
  _("IOPaint: disconnect debounce (seconds)"),
  _("how long the browser must stay closed before results are imported"), 8, 1, 120)

local function read_pref(key)
  return dt.preferences.read(MODULE, key, PREF_TYPES[key])
end

-- the configured source checkout, or the auto-detected one when the pref is empty
local function repo_path()
  local p = read_pref("iopaint_repo")
  if p ~= nil and p ~= "" then return p end
  return DETECTED_REPO
end

-- ---------------------------------------------------------------------------
-- paths / temp dirs
-- ---------------------------------------------------------------------------

local function base_tmp()
  if dt.configuration.tmp_dir and dt.configuration.tmp_dir ~= "" then
    return dt.configuration.tmp_dir
  end
  return os.getenv("TMPDIR") or os.getenv("TEMP") or "/tmp"
end

local ROOT = base_tmp()..PS.."iopaint_dt"
local INPUT_DIR = ROOT..PS.."input"
local OUTPUT_DIR = ROOT..PS.."output"
local LOG_FILE = ROOT..PS.."iopaint.log"

-- in-memory mapping: exported/output filename -> source image. Shared by the
-- automatic monitor and the manual "import results" action within a session.
local current_mapping = {}

-- ---------------------------------------------------------------------------
-- small helpers
-- ---------------------------------------------------------------------------

local function log(msg)
  dt.print_error("[iopaint] "..msg)
end

local function list_files(dir)
  local files = {}
  local cmd
  if OS == "windows" then
    cmd = string.format('dir /b "%s" 2>nul', dir)
  else
    cmd = string.format('ls -1 "%s" 2>/dev/null', dir)
  end
  local f = io.popen(cmd)
  if not f then return files end
  for line in f:lines() do
    if line ~= "" then files[#files + 1] = line end
  end
  f:close()
  return files
end

-- remove the top-level files of a directory (leaves subdirs such as thumbnails alone)
local function clear_dir(dir)
  for _, name in ipairs(list_files(dir)) do
    os.remove(dir..PS..name)
  end
end

-- the port the current session settled on (resolved per send; see resolve_port)
local active_port = nil

local function http_body(path, port)
  port = port or active_port or read_pref("port")
  local url = string.format("http://127.0.0.1:%d%s", port, path)
  local f = io.popen(string.format('curl -s -m 3 "%s"', url))
  if not f then return nil end
  local out = f:read("*a")
  f:close()
  if out == "" then return nil end
  return out
end

-- is *something* answering as an IOPaint server on this port?
local function is_server_running(port)
  local out = http_body("/api/v1/server-config", port)
  return out ~= nil and out:match('"plugins"') ~= nil
end

-- is the server on this port actually set up for this workflow, i.e. started with
-- --input (file browser) and --output-dir (auto-save)? A plain `iopaint start`
-- on the same port has neither, and would open an empty UI.
local function server_usable(port)
  local out = http_body("/api/v1/server-config", port)
  if out == nil then return false end
  return out:match('"enableAutoSaving"%s*:%s*true') ~= nil
     and out:match('"enableFileManager"%s*:%s*true') ~= nil
end

-- returns number of connected web clients, or nil if the server is unreachable
local function get_client_count(port)
  local out = http_body("/api/v1/connected_clients", port)
  if not out then return nil end
  local n = out:match('"count"%s*:%s*(%d+)')
  return n and tonumber(n) or nil
end

-- whether the server exposes the connected-clients endpoint (this fork only;
-- a vanilla IOPaint install returns "Not Found")
local function clients_endpoint_ok(port)
  local out = http_body("/api/v1/connected_clients", port)
  return out ~= nil and out:match('"count"') ~= nil
end

-- pick the port to use this session, honoring the preference (0 = auto-select).
-- returns: port (or nil), already_ours (bool), errmsg (string or nil)
local PORT_RANGE_LO, PORT_RANGE_HI = 8418, 8438
local function resolve_port()
  local configured = read_pref("port")
  if configured ~= 0 then
    if is_server_running(configured) then
      if server_usable(configured) then return configured, true, nil end
      return nil, false, string.format(_("a different IOPaint server is already running on port "
        .."%d (no file browser / auto-save). Stop it, change the port, or set the port to 0 for "
        .."auto-select."), configured)
    end
    return configured, false, nil
  end
  -- auto: reuse one of our usable servers if present, else first free port in range
  for p = PORT_RANGE_LO, PORT_RANGE_HI do
    if server_usable(p) then return p, true, nil end
  end
  for p = PORT_RANGE_LO, PORT_RANGE_HI do
    if not is_server_running(p) then return p, false, nil end
  end
  return nil, false, string.format(_("no free port found in %d-%d; stop some servers or set a "
    .."specific port"), PORT_RANGE_LO, PORT_RANGE_HI)
end

local function open_url(url)
  local cmd
  if OS == "windows" then
    cmd = string.format('start "" "%s"', url)
  elseif OS == "macos" then
    cmd = string.format('open "%s"', url)
  else
    cmd = string.format('xdg-open "%s" &', url)
  end
  os.execute(cmd)
end

-- true if a source checkout already has its web frontend built
local function frontend_built(repo)
  return df.check_if_file_exists(repo..PS.."iopaint"..PS.."web_app"..PS.."index.html")
end

-- build the web frontend inside a checkout (blocking; only needed on first run)
local function build_frontend(repo)
  dt.print(_("IOPaint: building web frontend (first run; this can take a few minutes)..."))
  local cmd
  if OS == "windows" then
    cmd = string.format(
      'cmd /c "cd /d ""%s\\web_app"" && (if not exist node_modules npm install) && npm run build '
      ..'&& (rmdir /s /q ""%s\\iopaint\\web_app"" 2>nul & xcopy /e /i /y dist ""%s\\iopaint\\web_app"")"',
      repo, repo, repo)
  else
    cmd = string.format('bash "%s/scripts/build_frontend.sh"', repo)
  end
  log("building frontend: "..cmd)
  local rc = dtsys.external_command(cmd)
  if rc ~= 0 or not frontend_built(repo) then
    return false
  end
  dt.print(_("IOPaint: web frontend built"))
  return true
end

-- python interpreter inside the checkout's virtualenv (created by darktable/setup.sh)
local function venv_python(repo)
  if OS == "windows" then
    return repo..PS..".venv"..PS.."Scripts"..PS.."python.exe"
  end
  return repo..PS..".venv"..PS.."bin"..PS.."python"
end

-- returns true if the launch was issued, false on a (reported) failure
local function start_server()
  local repo = repo_path() or ""
  if repo == "" then
    dt.print(_("IOPaint: could not locate the source checkout - set the 'source checkout' "
      .."preference to your darktable-iopaint clone, then run darktable/setup.sh in it"))
    return false
  end

  local py = venv_python(repo)
  if not df.check_if_file_exists(py) then
    dt.print(_("IOPaint: virtualenv not found - run setup.sh in ")..repo)
    log("missing venv python: "..py)
    return false
  end

  if not frontend_built(repo) and not build_frontend(repo) then
    dt.print(_("IOPaint: frontend build failed - run scripts/build_frontend.sh manually in ")..repo)
    return false
  end

  local args = string.format(
    'start --host 127.0.0.1 --port %d --input "%s" --output-dir "%s" --model %s %s',
    active_port, INPUT_DIR, OUTPUT_DIR, read_pref("model"), read_pref("extra_args") or "")

  local full
  if OS == "windows" then
    full = string.format('start /b "" cmd /c "cd /d ""%s"" && ""%s"" -m iopaint %s > ""%s"" 2>&1"',
      repo, py, args, LOG_FILE)
  else
    -- cd into the checkout so its iopaint package takes precedence on sys.path
    full = string.format('cd "%s" && "%s" -m iopaint %s > "%s" 2>&1 &', repo, py, args, LOG_FILE)
  end

  log("launching server: "..full)
  os.execute(full)
  return true
end

local function export_image(image, target)
  local exporter = dt.new_format("png")
  -- IOPaint (and the LaMa model) work in 8-bit RGB end to end, and the browser
  -- editor composites on an 8-bit canvas, so there is no point exporting deeper.
  exporter.bpp = 8
  exporter.max_width = 0
  exporter.max_height = 0
  exporter:write_image(image, target)
end

local function copy_metadata(src, dst)
  dst.rating = src.rating
  dst.red = src.red
  dst.green = src.green
  dst.blue = src.blue
  dst.yellow = src.yellow
  dst.purple = src.purple
  for _, tag in ipairs(dt.tags.get_tags(src)) do
    -- skip darktable's internal tags (e.g. "darktable|...")
    if string.sub(tag.name, 1, 9) ~= "darktable" then
      dt.tags.attach(tag, dst)
    end
  end
end

-- ---------------------------------------------------------------------------
-- import
-- ---------------------------------------------------------------------------

local function import_results()
  local suffix = read_pref("result_suffix") or ""
  local count = 0
  for _, name in ipairs(list_files(OUTPUT_DIR)) do
    local ext = df.get_filetype(name)
    if ext and ext:lower() == "png" then
      local src_image = current_mapping[name]
      if src_image then
        local out_file = OUTPUT_DIR..PS..name
        local dest = src_image.path..PS..df.get_basename(src_image.filename)..suffix.."."..ext
        dest = df.create_unique_filename(dest)
        if df.file_copy(out_file, dest) then
          local new_image = dt.database.import(dest)
          if new_image then
            copy_metadata(src_image, new_image)
            -- stack the result with its original (the source stays group leader)
            new_image:group_with(src_image)
            src_image:make_group_leader()
            count = count + 1
          else
            log("failed to import "..dest)
          end
        else
          log("failed to copy "..out_file.." -> "..dest)
        end
      end
    end
  end
  dt.print(string.format(_("IOPaint: imported %d image(s)"), count))
  return count
end

-- ---------------------------------------------------------------------------
-- session monitor (web-client lifecycle)
-- ---------------------------------------------------------------------------

local function monitor_and_import()
  local debounce = read_pref("disconnect_debounce")
  local connected_ever = false
  local zero_since = nil
  local started = os.time()

  while true do
    local n = get_client_count()
    if n == nil then
      -- server unreachable: if a session had started, treat it as ended
      if connected_ever then break end
    elseif n > 0 then
      connected_ever = true
      zero_since = nil
    else -- n == 0
      if connected_ever then
        zero_since = zero_since or os.time()
        if os.time() - zero_since >= debounce then break end
      elseif os.time() - started > 180 then
        dt.print(_("IOPaint: no browser connected, stopped watching (use 'import results' when done)"))
        return
      end
    end
    dt.control.sleep(2000)
  end

  import_results()
end

-- ---------------------------------------------------------------------------
-- send
-- ---------------------------------------------------------------------------

local function send_to_iopaint()
  local images = {}
  for _, img in ipairs(dt.gui.action_images) do
    images[#images + 1] = img
  end
  if #images == 0 then
    dt.print(_("IOPaint: no images selected"))
    return
  end

  -- Give immediate feedback: a transient message (visible in both lighttable and
  -- darkroom) plus a progress bar in the "background jobs" panel. Created before the
  -- synchronous export so there is a visual clue from the very first moment.
  dt.print(_("IOPaint: preparing…"))
  local job = dt.gui.create_job(_("IOPaint: preparing…"), true)
  -- yield once so darktable paints the message/progress bar before the heavy export
  dt.control.sleep(50)

  local ok, err = pcall(function()
    -- decide which port to use (pref, or auto-select when it is 0)
    local port, already, perr = resolve_port()
    if not port then
      dt.print(_("IOPaint: ")..perr)
      return
    end
    active_port = port

    -- when reusing our own running server, don't clobber an open browser session
    if already then
      local n = get_client_count()
      if n and n > 0 then
        dt.print(_("IOPaint: a session is already open in the browser; finish or close it first"))
        return
      end
    end

    df.mkdir(INPUT_DIR)
    df.mkdir(OUTPUT_DIR)
    clear_dir(INPUT_DIR)
    clear_dir(OUTPUT_DIR)
    current_mapping = {}

    dt.print(_("IOPaint: exporting selection…"))
    job.percent = 0.1
    local exported = 0
    for _, image in ipairs(images) do
      -- image.id makes the name unique even across folders with identical basenames;
      -- IOPaint saves the output under the same name, so we can map it back.
      local name = string.format("%d_%s.png", image.id, df.get_basename(image.filename))
      local target = INPUT_DIR..PS..name
      export_image(image, target)
      if df.check_if_file_exists(target) then
        current_mapping[name] = image
        exported = exported + 1
      else
        log("export failed for "..image.path..PS..image.filename)
      end
    end

    if exported == 0 then
      dt.print(_("IOPaint: no images could be exported"))
      return
    end
    dt.print(string.format(_("IOPaint: exported %d image(s)"), exported))
    job.percent = 0.2

    if not already then
      dt.print(_("IOPaint: starting server (loading model)…"))
      if not start_server() then return end
      local up = false
      for i = 1, 90 do -- wait for the (possible) build + model load
        if server_usable() then up = true break end
        job.percent = 0.2 + (i / 90) * 0.4
        dt.control.sleep(2000)
      end
      if not up then
        dt.print(_("IOPaint: server did not start - check ")..LOG_FILE)
        return
      end
    end
    job.percent = 0.6

    open_url(string.format("http://127.0.0.1:%d", active_port))

    if not clients_endpoint_ok() then
      -- vanilla IOPaint: no way to detect the browser session, so fall back to manual import
      dt.print(_("IOPaint: this server can't report the browser session (vanilla install?). "
        .."Edit and save your images, then run 'import IOPaint results'. Set the 'source checkout' "
        .."preference to a clone of this fork for automatic import."))
      return
    end

    -- wait for the browser/UI to actually load and connect
    dt.print(_("IOPaint: opening browser…"))
    local connected = false
    for i = 1, 60 do
      local n = get_client_count()
      if n and n > 0 then connected = true break end
      job.percent = 0.6 + (i / 60) * 0.4
      dt.control.sleep(2000)
    end

    if not connected then
      dt.print(_("IOPaint: browser did not open; edit and save, then run 'import IOPaint results'"))
      return
    end

    -- startup done: drop the progress bar before the (long) editing session
    job.valid = false
    dt.print(_("IOPaint: edit, press Ctrl+S to save each image, then close the tab to import"))
    monitor_and_import()
  end)

  if job.valid then job.valid = false end
  if not ok then
    dt.print(_("IOPaint error: ")..tostring(err))
    log("error: "..tostring(err))
  end
end

-- ---------------------------------------------------------------------------
-- UI registration
-- ---------------------------------------------------------------------------

local button_send = dt.new_widget("button") {
  label = _("send selection to IOPaint"),
  tooltip = _("export the selected images and open them in IOPaint"),
  clicked_callback = function() send_to_iopaint() end,
}

-- run a handler, surfacing any Lua error as a message instead of failing silently
local function guarded(fn)
  return function()
    local ok, err = pcall(fn)
    if not ok then
      dt.print(_("IOPaint error: ")..tostring(err))
      log("error: "..tostring(err))
    end
  end
end

local button_import = dt.new_widget("button") {
  label = _("import IOPaint results"),
  tooltip = _("scan the IOPaint output folder and import saved images next to the originals"),
  clicked_callback = guarded(import_results),
}

local widget = dt.new_widget("box") {
  orientation = "vertical",
  button_send,
  button_import,
}

local views = {
  [dt.gui.views.lighttable] = {"DT_UI_CONTAINER_PANEL_RIGHT_CENTER", 90},
  [dt.gui.views.darkroom] = {"DT_UI_CONTAINER_PANEL_LEFT_CENTER", 100},
}

dt.register_lib(MODULE, _("IOPaint"), true, false, views, widget, nil, nil)

dt.register_event("iopaint_send", "shortcut",
  function(_event, _shortcut) send_to_iopaint() end,
  _("IOPaint: send selection"))
dt.register_event("iopaint_import", "shortcut",
  function(_event, _shortcut) guarded(import_results)() end,
  _("IOPaint: import results"))

-- ---------------------------------------------------------------------------
-- script_manager integration
-- ---------------------------------------------------------------------------

local script_data = {}
script_data.metadata = {
  name = "iopaint",
  purpose = _("edit images with IOPaint and reimport the results"),
  author = "Daniele Pighin",
}
script_data.destroy = function()
  if dt.gui.libs[MODULE] then
    dt.gui.libs[MODULE].visible = false
  end
end
script_data.restart = function()
  if dt.gui.libs[MODULE] then
    dt.gui.libs[MODULE].visible = true
  end
end
script_data.show = function()
  if dt.gui.libs[MODULE] then
    dt.gui.libs[MODULE].visible = true
  end
end

return script_data
