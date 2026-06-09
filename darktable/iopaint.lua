-- SPDX-License-Identifier: GPL-3.0-or-later
-- Copyright (C) 2026 Daniele Pighin
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
  _("port for the IOPaint server this script manages. Keep it distinct from any IOPaint you "
    .."run manually (don't use 8080)."), 8418, 1, 65535)
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
  _("how long the browser must stay closed before results are imported. Small values import "
    .."sooner; raise it if a page reload is mistaken for closing the tab."), 2, 1, 30)

local function read_pref(key)
  return dt.preferences.read(MODULE, key, PREF_TYPES[key])
end

-- the source checkout to run from: the configured preference if it points at a
-- valid checkout, otherwise the auto-detected location. Falling back keeps a stale
-- preference (e.g. an old path after moving/renaming the repo) from breaking things.
local function repo_path()
  local p = read_pref("iopaint_repo")
  if p ~= nil and p ~= "" then
    if df.check_if_file_exists(p..PS.."darktable"..PS.."iopaint.lua") then return p end
    dt.print_error("[iopaint] configured source checkout '"..p..
      "' looks invalid; using auto-detected '"..DETECTED_REPO.."'")
  end
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

-- the port the current session is using (read from the preference at send time)
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
  if out:match('"enableAutoSaving"%s*:%s*true') == nil then return false end
  if out:match('"enableFileManager"%s*:%s*true') == nil then return false end
  -- also confirm the UI itself is served: a server whose static dir vanished
  -- (e.g. the checkout was moved/renamed) answers the API but 404s the root,
  -- which would otherwise be reused and open an empty page.
  local root = http_body("/", port)
  return root ~= nil and root:match("^%s*<") ~= nil
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

-- the "stop server" button (forward-declared so refresh_stop_button can toggle it)
local button_stop = nil

-- enable the stop button only while a server is running on the configured port
local function refresh_stop_button()
  if button_stop then button_stop.sensitive = is_server_running(read_pref("port")) end
end

-- stop the IOPaint server this script manages (kills whatever listens on the port)
local function stop_server()
  local port = read_pref("port")
  if not is_server_running(port) then
    dt.print(string.format(_("IOPaint: no server running on port %d"), port))
    refresh_stop_button()
    return
  end
  local cmd
  if OS == "windows" then
    cmd = string.format('powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort %d '
      .."-State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id "
      .."$_.OwningProcess -Force }\"", port)
  else
    cmd = string.format("lsof -ti tcp:%d -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null", port)
  end
  log("stopping server: "..cmd)
  os.execute(cmd)
  dt.control.sleep(1000)
  if is_server_running(port) then
    dt.print(string.format(_("IOPaint: could not stop the server on port %d"), port))
  else
    dt.print(_("IOPaint: server stopped"))
  end
  refresh_stop_button()
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

local MONITOR_SLOW_MS = 1000   -- poll interval while a client is connected (editing)
local MONITOR_FAST_MS = 250    -- poll interval while watching a possible disconnect

local function monitor_and_import()
  -- debounce absorbs a page reload (a brief disconnect+reconnect) without importing
  local debounce_ms = (read_pref("disconnect_debounce") or 2) * 1000
  local connected_ever = false
  local zero_ms = nil          -- ms observed at zero clients since a possible disconnect
  local waited = 0             -- ms spent waiting for the first connection

  while true do
    local n = get_client_count()
    if n == nil then
      if connected_ever then break end          -- server gone -> session over
    elseif n > 0 then
      connected_ever = true
      zero_ms = nil                              -- (re)connected: cancel the timer
    elseif connected_ever then                   -- n == 0 after having connected
      zero_ms = zero_ms or 0
      if zero_ms >= debounce_ms then break end
    elseif waited > 180000 then                  -- never connected
      dt.print(_("IOPaint: no browser connected, stopped watching (use 'import results' when done)"))
      return
    end

    -- poll fast only while a disconnect is in progress; slow the rest of the time
    local watching = connected_ever and zero_ms ~= nil
    local interval = watching and MONITOR_FAST_MS or MONITOR_SLOW_MS
    dt.control.sleep(interval)
    if watching then zero_ms = zero_ms + interval end
    if not connected_ever then waited = waited + interval end
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
    active_port = read_pref("port")

    -- check what (if anything) is already on the configured port
    local already = is_server_running(active_port)
    if already and not server_usable(active_port) then
      dt.print(string.format(_("IOPaint: a different server is already running on port %d "
        .."(no file browser / auto-save, or its UI is gone). Stop it or change the 'server "
        .."port' preference."), active_port))
      return
    end
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
    refresh_stop_button()  -- a server is now running
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

local button_send = dt.new_widget("button") {
  label = _("send selection to IOPaint"),
  tooltip = _("export the selected images and open them in IOPaint"),
  clicked_callback = guarded(send_to_iopaint),
}

local button_import = dt.new_widget("button") {
  label = _("import IOPaint results"),
  tooltip = _("scan the IOPaint output folder and import saved images next to the originals"),
  clicked_callback = guarded(import_results),
}

-- assign to the forward-declared local so refresh_stop_button can toggle it
button_stop = dt.new_widget("button") {
  label = _("stop IOPaint server"),
  tooltip = _("shut down the IOPaint server this script started"),
  clicked_callback = guarded(stop_server),
}

local widget = dt.new_widget("box") {
  orientation = "vertical",
  button_send,
  button_import,
  button_stop,
}

local views = {
  [dt.gui.views.lighttable] = {"DT_UI_CONTAINER_PANEL_RIGHT_CENTER", 90},
  [dt.gui.views.darkroom] = {"DT_UI_CONTAINER_PANEL_LEFT_CENTER", 100},
}

-- refresh the stop button's enabled state whenever the module's view is entered
dt.register_lib(MODULE, _("IOPaint"), true, false, views, widget,
  function() refresh_stop_button() end, nil)

pcall(refresh_stop_button)  -- set initial enabled state (defensive at load time)

dt.register_event("iopaint_send", "shortcut",
  function(_event, _shortcut) guarded(send_to_iopaint)() end,
  _("IOPaint: send selection"))
dt.register_event("iopaint_import", "shortcut",
  function(_event, _shortcut) guarded(import_results)() end,
  _("IOPaint: import results"))
dt.register_event("iopaint_stop", "shortcut",
  function(_event, _shortcut) guarded(stop_server)() end,
  _("IOPaint: stop server"))

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
