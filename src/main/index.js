import { app, shell, BrowserWindow, ipcMain, protocol, net, dialog, globalShortcut } from 'electron'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { basename, dirname, extname, join, parse, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { CONSOLE_EXTENSIONS, GAME_FILE_FILTERS } from '../shared/consoles'
import { createScraper } from './services/scraper'
import { mediaUrl, serveMedia, revokeMediaDirectory } from './services/local-media'
import { createGuideService } from './services/guideService'
import { createCoreManager } from './services/coreManager'
import { createLibraryStore } from './services/libraryStore'
import { biosDirectory, biosStatus, deleteBios } from './services/biosStatus'
import { gameMediaDirectory } from './services/mediaPaths'
import { startSessionBridge } from './services/sessionBridge'
import { createCoreCatalog, biosPlatformForCore } from './services/coreCatalog'
import { createGameImporter } from './services/gameImporter'
import { normalizeHotkeys } from '../shared/hotkeys'
import { runtimePaths, pathKey } from './services/platform'
import { seedBundledRetroArch } from './services/bundledRuntime'

/**
 * Resolved central ROM directory and writable RetroArch executable paths; all
 * launch/install/status operations must use this same runtime.
 */
const { gamesDirectory, retroarchDir, retroarchExecutable } = runtimePaths({
  packaged: app.isPackaged,
  appPath: app.getAppPath(),
  executable: app.getPath('exe'),
  userData: app.getPath('userData'),
  portableDirectory: process.env.PORTABLE_EXECUTABLE_DIR
})
/**
 * One serialized importer for the central games directory; source files are copied, never moved.
 */
const importGames = createGameImporter(gamesDirectory)
/**
 * Main-owned hotkey persistence shared with the background input bridge; renderer audio/language
 * settings use localStorage separately.
 */
const hotkeyFile = join(app.getPath('userData'), 'zenith-preferences.json')
/**
 * Normalized active keyboard/gamepad mapping; defaults survive a missing or damaged preferences
 * file.
 */
let hotkeys = normalizeHotkeys(null)
try {
  hotkeys = normalizeHotkeys(JSON.parse(fs.readFileSync(hotkeyFile, 'utf8')).hotkeys)
} catch {
  /* defaults */
}
/**
 * Host-bound core installer and physical-file verifier, shared by launch and status IPC.
 */
const cores = createCoreManager({ retroarchDir })
/**
 * Trusted catalog plus persisted per-game/platform core overrides under userData.
 */
const coreCatalog = createCoreCatalog({ retroarchDir, userData: app.getPath('userData') })
/**
 * Startup copy barrier: null means ready; an Error blocks launch but must not prevent
 * BrowserWindow creation.
 */
let retroarchPreparation = Promise.resolve(null)
/**
 * Lazily loaded imported/excluded registry; avoid reading the JSON file on every scan.
 */
let library
/**
 * Lazily load the imported/excluded ROM registry once; scanning and mutation share the same
 * in-memory state.
 */
const getLibrary = () => (library ||= createLibraryStore(app.getPath('userData')))
/**
 * The single running RetroArch process; menu/resume/stop handlers act only on this child.
 */
let activeChild = null
/**
 * Native background input helper owned by the active emulator session; stop it when that session
 * ends.
 */
let sessionBridge = null
/**
 * Prevents repeated Home/chord events from reopening the same always-on-top overlay.
 */
let sessionMenuOpen = false
/**
 * Game-ID tombstones hide in-progress deletions and reject concurrent duplicate deletion
 * requests.
 */
const deleting = new Set()
/**
 * Bring the Zenith overlay above the running emulator and emit session-menu. Ignore duplicate
 * requests and destroyed windows.
 */
function openSessionMenu() {
  if (!activeChild || !mainWindow || mainWindow.isDestroyed() || sessionMenuOpen) return
  sessionMenuOpen = true
  // Reassert kiosk/fullscreen before showing the hidden dashboard above the taskbar.
  mainWindow.setKiosk(true)
  mainWindow.setFullScreen(true)
  // Raise the frameless overlay above fullscreen emulator windows, not just normal windows.
  // resumeSession and child cleanup must release this level before returning to the game.
  mainWindow.setAlwaysOnTop(true, 'screen-saver')
  mainWindow.show()
  mainWindow.focus()
  sessionBridge?.focusZenith()
  mainWindow.webContents.send('session-menu', true)
}
/**
 * Dismiss the overlay, hide Zenith, and ask the native bridge to restore emulator focus. The
 * child remains alive.
 */
function resumeSession() {
  sessionMenuOpen = false
  mainWindow?.setAlwaysOnTop(false)
  mainWindow?.webContents.send('session-menu', false)
  mainWindow?.hide()
  sessionBridge?.resume()
  return { success: true }
}
/**
 * Dashboard window reference reused across IPC and child-process callbacks; check destruction
 * before sending events.
 */
let mainWindow
/**
 * Synchronous lock spanning preparation, child spawn, and exit; prevents duplicate sessions and
 * destructive BIOS/ROM operations.
 */
let launchInProgress = false
/**
 * Reverse platform-extension lookup built from the shared registry; ISO PSP hints are applied
 * during scanning.
 */
const consoleByExtension = new Map(
  Object.entries(CONSOLE_EXTENSIONS).flatMap(
    /**
     * Expand Object.entries(CONSOLE_EXTENSIONS) entries for consoleByExtension, flattening each result into the shared lookup/list.
     *
     * @param {*} input1 - Value supplied by the enclosing operation; interpreted in this callback's local scope.
     */
    ([system, extensions]) =>
      extensions.map(
        /**
         * Project each extensions entry for consoleByExtension; preserve input ordering in the derived collection.
         *
         * @param {*} extension - Value supplied by the enclosing operation; interpreted in this callback's local scope.
         */
        (extension) => [extension, system]
      )
  )
)
/**
 * Capability table for adjacent ROM images; only registered URLs are exposed through game-cover.
 */
const localCovers = new Map()
/**
 * Singleton artwork/media pipeline with serialized manifest writes and deletion barriers.
 */
let scraper
/**
 * Singleton optional lore/manual provider with a shared pending-request registry.
 */
let guideService
/**
 * Create the shared guide cache with both features enabled; all guide IPC handlers reuse its
 * pending-request registry.
 */
function getGuideService() {
  guideService ||= createGuideService({
    userData: app.getPath('userData'),
    features: { manualsEnabled: true, loreEnabled: true }
  })
  return guideService
}
/**
 * Resolve an untrusted renderer game ID against the current library before any guide, core, or
 * deletion operation.
 *
 * @param {string} gameId - Stable library/media identity; Main resolves or validates it before accessing files.
 */
function guideGame(gameId) {
  return typeof gameId === 'string'
    ? getLocalGames().find(
        /**
         * Select the first matching getLocalGames() entry for guideGame; absence is handled by the caller's fallback.
         *
         * @param {*} game - Value supplied by the enclosing operation; interpreted in this callback's local scope.
         */
        (game) => game.gameId === gameId
      )
    : null
}
/**
 * Create one scraper tied to userData. Forward completed background media downloads only to a
 * live renderer.
 */
function getScraper() {
  scraper ||= createScraper({
    userData: app.getPath('userData'),
    /**
     * Decorate the completed game record with local protocol URLs and notify a surviving renderer
     * without forcing a rescan.
     *
     * @param {Object} game - Library game record, including identity, platform, and available local media.
     */
    onMediaUpdated: (game) => {
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed())
        mainWindow.webContents.send('game-media-updated', decorateGame(game))
    }
  })
  return scraper
}

/**
 * Merge disk-backed media with a scanned ROM and register renderer-safe URLs. Prefer downloaded
 * box art and landscape snapshots.
 *
 * @param {Object} game - Library game record, including identity, platform, and available local media.
 */
function decorateGame(game) {
  const enriched = getScraper().enrich(game)
  const cover = enriched.media.boxart || game.cover
  const backdrop = enriched.media.snap || enriched.media.titleScreen || cover
  return {
    ...enriched,
    cover,
    backdrop,
    coverUrl: enriched.media.boxart ? mediaUrl(cover) : game.coverUrl,
    backdropUrl: mediaUrl(backdrop),
    titleScreenUrl: mediaUrl(enriched.media.titleScreen),
    musicUrl: mediaUrl(enriched.media.music),
    videoUrl: mediaUrl(enriched.media.video)
  }
}

// A local-only image protocol also works when Vite serves the renderer over HTTP.
protocol.registerSchemesAsPrivileged([
  { scheme: 'game-cover', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  {
    scheme: 'game-media',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }
])

/**
 * Scan regular files directly in the central games directory, apply PSP ISO hints, merge
 * imported entries, and omit pending deletions.
 */
function getLocalGames() {
  fs.mkdirSync(gamesDirectory, { recursive: true })
  const files = fs.readdirSync(gamesDirectory, { withFileTypes: true }).filter(
    /**
     * Retain only fs .readdirSync(gamesDirectory, { withFileTypes: true }) entries satisfying files's local predicate; excluded values do not reach the next stage.
     *
     * @param {*} file - Value supplied by the enclosing operation; interpreted in this callback's local scope.
     */
    (file) => file.isFile()
  )
  const fileNames = new Map(
    files.map(
      /**
       * Project each files entry for fileNames; preserve input ordering in the derived collection.
       *
       * @param {*} file - Value supplied by the enclosing operation; interpreted in this callback's local scope.
       */
      (file) => [pathKey(file.name), file.name]
    )
  )

  const local = files
    .filter(
      /**
       * Retain only files entries satisfying local's local predicate; excluded values do not reach the next stage.
       *
       * @param {*} file - Value supplied by the enclosing operation; interpreted in this callback's local scope.
       */
      (file) =>
        consoleByExtension.has(extname(file.name).toLowerCase()) &&
        !getLibrary().excluded(join(gamesDirectory, file.name))
    )
    .sort(
      /**
       * Order files .filter( (file) => consoleByExtension.has(extname(file.name).toLowerCase()) && !getLibrar candidates deterministically before local consumes the preferred result.
       *
       * @param {*} a - Value supplied by the enclosing operation; interpreted in this callback's local scope.
       * @param {*} b - Value supplied by the enclosing operation; interpreted in this callback's local scope.
       */
      (a, b) => a.name.localeCompare(b.name)
    )
    .map(
      /**
       * Project each files .filter( (file) => consoleByExtension.has(extname(file.name).toLowerCase()) && !getLibrar entry for local; preserve input ordering in the derived collection.
       *
       * @param {*} file - Value supplied by the enclosing operation; interpreted in this callback's local scope.
       */
      (file) => {
        const { name, ext } = parse(file.name)
        const gamePath = join(gamesDirectory, file.name)
        const system =
          ext.toLowerCase() === '.iso' && /psp|vice city stories/i.test(gamePath)
            ? 'PSP'
            : consoleByExtension.get(ext.toLowerCase())
        const coverName =
          fileNames.get(pathKey(`${name}.jpg`)) || fileNames.get(pathKey(`${name}.png`))
        const cover = coverName ? join(gamesDirectory, coverName) : null
        const coverUrl = coverName ? `game-cover://local/${encodeURIComponent(coverName)}` : null
        if (coverUrl) localCovers.set(coverUrl, cover)

        return decorateGame({
          id: file.name,
          title: name,
          fileName: file.name,
          path: gamePath,
          system,
          systemShort: system,
          cover,
          backdrop: cover,
          coverUrl
        })
      }
    )
  const paths = new Set(
    local.map(
      /**
       * Project each local entry for paths; preserve input ordering in the derived collection.
       *
       * @param {*} game - Value supplied by the enclosing operation; interpreted in this callback's local scope.
       */
      (game) => pathKey(game.path)
    )
  )
  return [
    ...local,
    ...getLibrary()
      .list()
      .filter(
        /**
         * Retain only getLibrary() .list() entries satisfying getLocalGames's local predicate; excluded values do not reach the next stage.
         *
         * @param {*} game - Value supplied by the enclosing operation; interpreted in this callback's local scope.
         */
        (game) => !paths.has(pathKey(game.path))
      )
      .map(
        /**
         * Project each getLibrary() .list() .filter((game) => !paths.has(pathKey(game.path))) entry for getLocalGames; preserve input ordering in the derived collection.
         *
         * @param {*} game - Value supplied by the enclosing operation; interpreted in this callback's local scope.
         */
        (game) => decorateGame({ ...game, coverUrl: mediaUrl(game.cover) })
      )
  ]
    .filter(
      /**
       * Retain only [ ...local, ...getLibrary() .list() .filter((game) => !paths.has(pathKey(game.path))) .map((gam entries satisfying getLocalGames's local predicate; excluded values do not reach the next stage.
       *
       * @param {*} game - Value supplied by the enclosing operation; interpreted in this callback's local scope.
       */
      (game) => !deleting.has(game.gameId)
    )
    .sort(
      /**
       * Order [ ...local, ...getLibrary() .list() .filter((game) => !paths.has(pathKey(game.path))) .map((gam candidates deterministically before getLocalGames consumes the preferred result.
       *
       * @param {*} a - Value supplied by the enclosing operation; interpreted in this callback's local scope.
       * @param {*} b - Value supplied by the enclosing operation; interpreted in this callback's local scope.
       */
      (a, b) => a.title.localeCompare(b.title)
    )
}

/**
 * Check that a candidate path is a regular file; an absent file is false, while other filesystem
 * failures reach the caller.
 *
 * @param {string} filePath - Filesystem path to inspect.
 */
function isFile(filePath) {
  return fs.statSync(filePath, { throwIfNoEntry: false })?.isFile() === true
}

/**
 * Resolve the selected BIOS platform below the active RetroArch system directory using the
 * shared BIOS rules.
 *
 * @param {string} platform - Platform selector; OS helpers accept win32/linux, BIOS and IPC helpers accept a library console ID.
 */
function getBiosDirectory(platform) {
  return biosDirectory(retroarchDir, platform)
}

/**
 * Ask the user for a BIOS dump, normalize its filename, and copy exclusively into the platform
 * directory. Return cancellation or an explicit error without overwriting files.
 *
 * @param {Object} _event - Electron invoke event; unused when no renderer notification is needed.
 * @param {string} platform - Platform selector; OS helpers accept win32/linux, BIOS and IPC helpers accept a library console ID.
 */
async function uploadBios(_event, platform) {
  try {
    const directory = getBiosDirectory(platform)
    const options = {
      title: `${platform} BIOS file`,
      properties: ['openFile'],
      filters: [{ name: 'BIOS Files', extensions: ['bin', 'rom'] }]
    }
    const selection =
      mainWindow && !mainWindow.isDestroyed()
        ? await dialog.showOpenDialog(mainWindow, options)
        : await dialog.showOpenDialog(options)
    if (selection.canceled || !selection.filePaths.length) return { success: false, canceled: true }
    const source = selection.filePaths[0]
    const extension = extname(source).toLowerCase()
    if (!['.bin', '.rom'].includes(extension) || !isFile(source)) {
      return { success: false, error: 'Please select a .bin or .rom BIOS file.' }
    }
    // PS2 discovery requires .bin; preserve ROM dump bytes and normalize only the suffix.
    let fileName =
      platform === 'PS2' && extension === '.rom' ? `${parse(source).name}.bin` : basename(source)
    if (['PS1', 'Dreamcast'].includes(platform)) fileName = fileName.toLowerCase()
    fs.mkdirSync(directory, { recursive: true })
    const destination = join(directory, fileName)
    if (!fs.existsSync(destination) || fs.realpathSync(source) !== fs.realpathSync(destination)) {
      fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL)
    }
    return { success: true, fileName, status: biosStatus(retroarchDir, platform) }
  } catch (error) {
    return {
      success: false,
      error:
        error.code === 'EEXIST'
          ? 'A BIOS with this name already exists. It was not overwritten.'
          : `BIOS upload failed: ${error.message}`
    }
  }
}

/**
 * Create the platform BIOS directory and open it with the OS file manager; convert shell and
 * filesystem failures to an IPC result.
 *
 * @param {Object} _event - Electron invoke event; unused when no renderer notification is needed.
 * @param {string} platform - Platform selector; OS helpers accept win32/linux, BIOS and IPC helpers accept a library console ID.
 */
async function openBiosFolder(_event, platform) {
  try {
    const directory = getBiosDirectory(platform)
    fs.mkdirSync(directory, { recursive: true })
    const error = await shell.openPath(directory)
    return error ? { success: false, error: `Could not open folder: ${error}` } : { success: true }
  } catch (error) {
    return { success: false, error: `Could not open folder: ${error.message}` }
  }
}

/**
 * Reset renderer launch state before displaying the native warning. Return the same message as a
 * failed launch result.
 *
 * @param {string} message - User-visible result/error message; a falsy session message indicates success.
 */
async function showLaunchError(message) {
  const options = { type: 'warning', title: 'Game could not start', message, buttons: ['OK'] }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('game-stopped')
    await dialog.showMessageBox(mainWindow, options)
  } else {
    await dialog.showMessageBox(options)
  }
  return { success: false, error: message }
}

/**
 * Serialize sessions and wait for runtime preparation; verify the library ROM, physical core,
 * and BIOS before writing session.cfg and spawning RetroArch. Resolve IPC only after exit or a
 * handled failure.
 *
 * @param {Object} event - Electron or DOM event associated with this operation.
 * @param {Object} request - Launch payload or protocol Request, as specified by the surrounding handler.
 */
async function launchGame(event, request) {
  if (launchInProgress) return { success: false, error: 'A game is already running or launching.' }
  launchInProgress = true
  try {
    const preparationError = await retroarchPreparation
    if (preparationError) {
      return await showLaunchError(`RetroArch preparation failed: ${preparationError.message}`)
    }
    const { gamePath, consoleType } = request || {}
    if (typeof gamePath !== 'string' || typeof consoleType !== 'string') {
      return await showLaunchError('Invalid game request.')
    }
    const executable = retroarchExecutable
    if (!isFile(executable)) {
      return await showLaunchError(
        `RetroArch was not found. Please add ${process.platform === 'win32' ? 'retroarch.exe' : 'retroarch'} to ${retroarchDir}.`
      )
    }
    // Only launch ROMs recognized by the local library, using the detected system.
    if (
      !getLocalGames().some(
        /**
         * Short-circuit when any getLocalGames() entry meets launchGame's condition.
         *
         * @param {*} game - Value supplied by the enclosing operation; interpreted in this callback's local scope.
         */
        (game) => game.path === gamePath && game.systemShort === consoleType
      )
    ) {
      return await showLaunchError('Game file is missing or its platform does not match.')
    }
    if (process.platform !== 'win32') {
      try {
        fs.accessSync(executable, fs.constants.X_OK)
      } catch {
        return await showLaunchError(
          'RetroArch is not executable. Grant execute permission to: ' + executable
        )
      }
    }
    const game = getLocalGames().find(
      /**
       * Select the first matching getLocalGames() entry for game; absence is handled by the caller's fallback.
       *
       * @param {*} game - Value supplied by the enclosing operation; interpreted in this callback's local scope.
       */
      (game) => game.path === gamePath
    )
    const core = coreCatalog.get(game.gameId, consoleType) || cores.find(consoleType)
    if (!core) return { success: false, error: 'missing_core', platform: consoleType }
    const biosPlatform = biosPlatformForCore(core, consoleType)
    const bios = biosStatus(retroarchDir, biosPlatform, game.region)
    if (!bios.ready)
      return { success: false, error: 'missing_bios', platform: biosPlatform, ...bios }
    const runtime = gameMediaDirectory(app.getPath('userData'), game.gameId)
    const saveDir = join(runtime, 'saves'),
      stateDir = join(runtime, 'states')
    fs.mkdirSync(saveDir, { recursive: true })
    fs.mkdirSync(stateDir, { recursive: true })
    /**
     * Absolute per-game appendconfig path; never depend on the launcher process working directory to
     * find session overrides.
     */
    const config = resolve(runtime, 'session.cfg')
    /**
     * Normalize separators and quote trusted filesystem paths for RetroArch config syntax, not shell
     * command interpolation.
     *
     * @param {*} value - Input value being normalized, displayed, or committed by this helper.
     */
    const quote = (value) => '"' + value.replace(/\\/g, '/').replace(/"/g, '') + '"'
    fs.writeFileSync(
      config,
      [
        'pause_nonactive = true',
        'config_save_on_exit = false',
        // Later per-core/content overrides must not re-enable RetroArch menu bindings.
        'auto_overrides_enable = "false"',
        // Apply synchronization on every launch, including existing user installations.
        'video_vsync = "true"',
        'video_refresh_rate = "60.0"',
        'audio_sync = "true"',
        'audio_rate_control = "true"',
        'fastforward_ratio = "1.0"',
        'video_max_swapchain_images = "3"',
        'vrr_runloop_enable = "true"',
        'notification_show_osd = "false"',
        'notification_show_autoconfig = "false"',
        'video_osd_widgets = "false"',
        'notification_show_core_load = "false"',
        // Disable the classic text OSD as well as modern notification widgets.
        'video_font_enable = "false"',
        // XAudio is Windows-specific; preserve the native driver on Linux/Steam Deck.
        ...(process.platform === 'win32' ? ['audio_driver = "xaudio"'] : []),
        'audio_enable = "true"',
        'audio_mute_enable = "false"',
        'audio_volume = "0.0"',
        'input_menu_toggle_gamepad_combo = "0"',
        'input_menu_toggle_btn = "nul"',
        'input_menu_toggle = "nul"',
        // Clear axis and hotkey-modifier bindings inherited from an existing RetroArch config.
        // The native Zenith bridge owns the menu chord while the emulator has focus.
        'input_menu_toggle_axis = "nul"',
        'input_menu_toggle_mbtn = "nul"',
        'input_hotkey_block_delay = "0"',
        'input_enable_hotkey = "nul"',
        'input_enable_hotkey_btn = "nul"',
        'input_exit_emulator = "nul"',
        'input_quit_gamepad_combo = "0"',
        'system_directory = ' + quote(join(retroarchDir, 'system')),
        'savefile_directory = ' + quote(saveDir),
        'savestate_directory = ' + quote(stateDir)
      ].join('\n')
    )

    /**
     * Physically verified absolute core path; this is the same location the installer writes and
     * status IPC inspects.
     */
    const corePath = cores.pathFor(core)
    if (!corePath) return { success: false, error: 'missing_core', platform: consoleType }
    // Keep the IPC request pending until exit so the UI cannot launch a second session.
    return await new Promise(
      /**
       * Bridge launchGame's callback-based work into a Promise; settle it through the supplied resolve/reject functions.
       *
       * @param {*} resolve - Fulfill the pending operation.
       */
      (resolve) => {
        // spawn takes the executable separately from its arguments; no shell quoting is needed.
        const child = spawn(
          executable,
          ['-L', corePath, gamePath, '-f', '--appendconfig', config],
          {
            cwd: retroarchDir,
            shell: false,
            detached: true,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe']
          }
        )
        activeChild = child
        child.stdout.on(
          'data',
          /**
           * Handle data events for launchGame; lifecycle cleanup or a one-shot subscription controls how long this callback remains active.
           *
           * @param {*} data - Value supplied by the enclosing operation; interpreted in this callback's local scope.
           */
          (data) => console.log(`[RetroArch stdout] ${data.toString()}`)
        )
        child.stderr.on(
          'data',
          /**
           * Handle data events for launchGame; lifecycle cleanup or a one-shot subscription controls how long this callback remains active.
           *
           * @param {*} data - Value supplied by the enclosing operation; interpreted in this callback's local scope.
           */
          (data) => console.log(`[RetroArch stderr] ${data.toString()}`)
        )
        /**
         * Idempotence guard because error, exit, and close may all arrive for one child.
         */
        let finished = false
        /**
         * Finalize a child exactly once across error/exit/close events; stop hooks, restore Zenith, and
         * settle the pending launch Promise.
         *
         * @param {string} message - User-visible result/error message; a falsy session message indicates success.
         */
        const finish = async (message) => {
          if (finished) return
          finished = true
          activeChild = null
          sessionBridge?.stop()
          sessionBridge = null
          sessionMenuOpen = false
          globalShortcut.unregister('F10')
          globalShortcut.unregister('Escape')
          if (!event.sender.isDestroyed()) event.sender.send('game-stopped')
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.setAlwaysOnTop(false)
            mainWindow.show()
            mainWindow.restore()
            mainWindow.focus()
          }
          if (!message) {
            resolve({ success: true })
            return
          }
          try {
            resolve(await showLaunchError(message))
          } catch {
            resolve({ success: false, error: message })
          }
        }
        child.once(
          'spawn',
          /**
           * Handle spawn events for launchGame; lifecycle cleanup or a one-shot subscription controls how long this callback remains active.
           */
          () => {
            if (!event.sender.isDestroyed()) event.sender.send('game-started')
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide()
            sessionBridge = startSessionBridge(
              child.pid,
              join(__dirname, '../../resources/gamepad-bridge.ps1'),
              openSessionMenu,
              hotkeys,
              mainWindow.getNativeWindowHandle()
            )
            globalShortcut.register('F10', openSessionMenu)
            globalShortcut.register(
              'Escape',
              /**
               * Complete the register callback step owned by launchGame; caller arguments and captured state determine this stage's result.
               */
              () => (sessionMenuOpen ? resumeSession() : openSessionMenu())
            )
          }
        )
        child.once(
          'error',
          /**
           * Handle error events for launchGame; lifecycle cleanup or a one-shot subscription controls how long this callback remains active.
           *
           * @param {*} error - Failure from the preceding operation.
           */
          (error) => {
            void finish(`RetroArch could not start: ${error.message}`)
          }
        )
        /**
         * Treat a clean exit or an intentional kill as success; route unexpected exit codes/signals
         * through the common finalizer.
         *
         * @param {number|string} code - Process exit code or normalized physical key code, depending on the handler.
         * @param {string} signal - Optional child-process termination signal.
         */
        const onExit = (code, signal) => {
          void finish(
            code === 0 || child.killed ? null : `RetroArch exited unexpectedly (${signal || code}).`
          )
        }
        child.once('exit', onExit)
        child.once('close', onExit)
      }
    )
  } catch (error) {
    return await showLaunchError(`Game could not start: ${error.message}`)
  } finally {
    launchInProgress = false
  }
}

/**
 * Create the isolated frameless fullscreen dashboard, reveal it when ready, and load Vite in
 * development or the packaged HTML in production.
 */
function createWindow() {
  // Fullscreen + no native frame removes title-bar controls without changing OS security policy.
  // Exit remains available through the Zenith menu (Escape/F10 or the configured chord).
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 800,
    show: false,
    fullscreen: true,
    kiosk: true,
    frame: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      autoplayPolicy: 'no-user-gesture-required',
      sandbox: false
    }
  })

  mainWindow.on(
    'ready-to-show',
    /**
     * Handle ready-to-show events for createWindow; lifecycle cleanup or a one-shot subscription controls how long this callback remains active.
     */
    () => {
      mainWindow.show()
    }
  )

  mainWindow.webContents.setWindowOpenHandler(
    /**
     * Open requested external links with the OS browser and deny a new embedded renderer window.
     *
     * @param {*} details - Value supplied by the enclosing operation; interpreted in this callback's local scope.
     */
    (details) => {
      shell.openExternal(details.url)
      return { action: 'deny' }
    }
  )

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(
  /**
   * Register Main protocols and IPC only after Electron is ready, start packaged preparation without blocking the window, then create the dashboard.
   */
  () => {
    if (app.isPackaged) {
      // Initialization must never prevent the library window from opening.
      // Only a launch request waits for copying; failures remain visible in the log.
      retroarchPreparation = seedBundledRetroArch({
        resourcesPath: process.resourcesPath,
        retroarchDir
      })
        .then(
          /**
           * Continue index.js after the preceding asynchronous stage resolves; the returned value or Promise feeds the same chain.
           */
          () => null
        )
        .catch(
          /**
           * Handle the rejected stage of index.js here so its failure follows this operation's fallback/error policy.
           *
           * @param {*} error - Failure from the preceding operation.
           */
          (error) => {
            console.warn('[RetroArch setup] Preparation incomplete:', error)
            return error
          }
        )
    }
    // Set app user model id for windows
    electronApp.setAppUserModelId('com.electron')

    // Default open or close DevTools by F12 in development
    // and ignore CommandOrControl + R in production.
    // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
    app.on(
      'browser-window-created',
      /**
       * Handle browser-window-created events for index.js; lifecycle cleanup or a one-shot subscription controls how long this callback remains active.
       *
       * @param {*} _ - Value supplied by the enclosing operation; interpreted in this callback's local scope.
       * @param {*} window - Value supplied by the enclosing operation; interpreted in this callback's local scope.
       */
      (_, window) => {
        optimizer.watchWindowShortcuts(window)
      }
    )

    protocol.handle(
      'game-cover',
      /**
       * Resolve the game-cover request through Main's registered local-file capabilities; unregistered paths are not served.
       *
       * @param {*} request - Value supplied by the enclosing operation; interpreted in this callback's local scope.
       */
      (request) => {
        const cover = localCovers.get(request.url)
        return cover ? net.fetch(pathToFileURL(cover).href) : new Response(null, { status: 404 })
      }
    )
    /**
     * Read the normalized persistent keyboard/gamepad combination.
     */
    ipcMain.handle('get-hotkeys', () => hotkeys)
    /**
     * Normalize and atomically persist the combination, then update the running native bridge.
     *
     * @param {Object} _event - Electron invoke event; unused when no renderer notification is needed.
     * @param {*} value - Input value being normalized, displayed, or committed by this helper.
     */
    ipcMain.handle('save-hotkeys', async (_event, value) => {
      try {
        const next = normalizeHotkeys(value)
        await fs.promises.mkdir(app.getPath('userData'), { recursive: true })
        await fs.promises.writeFile(hotkeyFile + '.tmp', JSON.stringify({ hotkeys: next }))
        await fs.promises.rename(hotkeyFile + '.tmp', hotkeyFile)
        hotkeys = next
        sessionBridge?.update(hotkeys)
        return { success: true, hotkeys }
      } catch (error) {
        return { success: false, error: error.message }
      }
    })
    /**
     * Stop an active emulator and quit Zenith through the normal Electron lifecycle.
     */
    ipcMain.handle('quit-app', () => {
      activeChild?.kill()
      app.quit()
      return { success: true }
    })
    /**
     * Return current library records with local protocol URLs without waiting for network scraping.
     */
    ipcMain.handle('get-local-games', () => getLocalGames())
    /**
     * Open the native ROM picker and copy supported selections to the central library.
     */
    ipcMain.handle('add-games', async () => {
      try {
        const selection = await dialog.showOpenDialog(mainWindow, {
          properties: ['openFile', 'multiSelections'],
          filters: GAME_FILE_FILTERS
        })
        if (selection.canceled) return { success: false, canceled: true }
        const copied = await importGames(selection.filePaths)
        getLibrary().add(copied)
        return { success: true, count: copied.length }
      } catch (error) {
        return { success: false, error: error.message }
      }
    })
    /**
     * Resolve a library ID and remove its central ROM, caches, and records after pending writers
     * settle.
     *
     * @param {Object} _event - Electron invoke event; unused when no renderer notification is needed.
     * @param {string} gameId - Stable library/media identity; Main resolves or validates it before accessing files.
     */
    ipcMain.handle('delete-game', async (_event, gameId) => {
      if (launchInProgress) return { success: false, error: 'Stop the running game first.' }
      const game = guideGame(gameId)
      if (!game || deleting.has(gameId)) return { success: false, error: 'Game unavailable.' }
      deleting.add(gameId)
      try {
        // Only a library-resolved ROM can be removed; renderer never supplies a deletion path.
        if (pathKey(dirname(game.path)) === pathKey(gamesDirectory))
          await fs.promises.unlink(game.path)
        await Promise.all([getScraper().forget(gameId), getGuideService().whenIdle()])
        const directory = gameMediaDirectory(app.getPath('userData'), gameId)
        // gameMediaDirectory validates the ID and confines this recursive deletion to userData/media.
        await fs.promises.rm(directory, { recursive: true, force: true })
        for (const [folder, ext] of [
          ['music', 'mp3'],
          ['videos', 'mp4']
        ]) {
          await fs.promises.rm(join(app.getPath('userData'), 'media', folder, `${gameId}.${ext}`), {
            force: true
          })
        }
        await coreCatalog.forget(gameId)
        getLibrary().remove(game.path)
        revokeMediaDirectory(directory)
        return { success: true }
      } catch (error) {
        return { success: false, error: error.message }
      } finally {
        deleting.delete(gameId)
      }
    })
    /**
     * List the trusted official/verified-local core catalog, including offline fallback status.
     */
    ipcMain.handle('list-cores', () => coreCatalog.list())
    /**
     * Validate the game/platform target and catalog member, install it, and persist the selection
     * only on success.
     *
     * @param {Object} _event - Electron invoke event; unused when no renderer notification is needed.
     * @param {Object} options2 - Named inputs for this operation.
     * @param {string} options2.gameId - Stable library/media identity; Main resolves or validates it before accessing files.
     * @param {string} options2.platform - Platform selector; OS helpers accept win32/linux, BIOS and IPC helpers accept a library console ID.
     * @param {*} options2.core - Input used by this helper; see its operation contract above.
     */
    ipcMain.handle('select-core', async (_event, { gameId, platform, core } = {}) => {
      try {
        const preparationError = await retroarchPreparation
        if (preparationError) throw preparationError
        if (launchInProgress) throw Error('Stop the running game first.')
        const game = gameId ? guideGame(gameId) : null
        if (
          gameId ? !game : !Object.hasOwn(CONSOLE_EXTENSIONS, platform) || platform === 'Unassigned'
        )
          throw Error('Invalid core selection target.')
        if (!(await coreCatalog.allowed(core)))
          throw Error('Core is not in the trusted catalog or installed locally.')
        const result = await cores.installNamed(core)
        if (result.success)
          await coreCatalog.select(game ? 'game:' + game.gameId : 'platform:' + platform, core)
        return result
      } catch (error) {
        return { success: false, error: error.message }
      }
    })
    /**
     * Install and physically verify the mapped platform core in the same runtime directory used by
     * launch.
     *
     * @param {Object} _event - Electron invoke event; unused when no renderer notification is needed.
     * @param {string} system - Console ID from the shared platform registry.
     */
    ipcMain.handle('install-core', async (_event, system) => {
      try {
        const preparationError = await retroarchPreparation
        if (preparationError) throw preparationError
        return await cores.install(system)
      } catch (error) {
        return { success: false, error: error.message }
      }
    })
    /**
     * Read physical core and BIOS status for platforms currently represented in the library.
     */
    ipcMain.handle('get-system-status', () =>
      [
        ...new Set(
          getLocalGames().map(
            /**
             * Project each getLocalGames() entry for index.js; preserve input ordering in the derived collection.
             *
             * @param {*} game - Value supplied by the enclosing operation; interpreted in this callback's local scope.
             */
            (game) => game.systemShort
          )
        )
      ].map(
        /**
         * Project each [...new Set(getLocalGames().map((game) => game.systemShort))] entry for index.js; preserve input ordering in the derived collection.
         *
         * @param {*} platform - Value supplied by the enclosing operation; interpreted in this callback's local scope.
         */
        (platform) => {
          const core = coreCatalog.get(null, platform) || cores.find(platform)
          /**
           * Physically verified absolute core path; this is the same location the installer writes and
           * status IPC inspects.
           */
          const corePath = cores.pathFor(core)
          return {
            platform,
            core: corePath ? core : null,
            corePath,
            coreDirectory: join(retroarchDir, 'cores'),
            bios: biosStatus(retroarchDir, platform)
          }
        }
      )
    )
    /**
     * Bring Zenith above an active emulator and notify the renderer to show its session panel.
     */
    ipcMain.handle('show-session-menu', () => {
      openSessionMenu()
      return { success: !!activeChild }
    })
    /**
     * Hide the session panel and restore emulator focus if a child is still running.
     */
    ipcMain.handle('resume-session', () => (activeChild ? resumeSession() : { success: false }))
    /**
     * Request termination of the active emulator; normal exit handling restores the dashboard.
     */
    ipcMain.handle('stop-session', () => {
      if (activeChild) activeChild.kill()
      return { success: true }
    })
    /**
     * Return resolved runtime paths and host information for diagnostics.
     */
    ipcMain.handle('get-runtime-info', () => ({
      platform: process.platform,
      retroarchDir,
      gamesDirectory
    }))
    /**
     * Return enabled guide feature flags without making network requests.
     */
    ipcMain.handle('get-guide-features', () => getGuideService().getFeatures())
    /**
     * Resolve a library game before returning optional cached/downloaded Wikipedia lore; failures
     * yield null.
     *
     * @param {Object} _event - Electron invoke event; unused when no renderer notification is needed.
     * @param {string} gameId - Stable library/media identity; Main resolves or validates it before accessing files.
     */
    ipcMain.handle('get-game-lore', async (_event, gameId) => {
      try {
        const game = guideGame(gameId)
        return game ? await getGuideService().getLore(game) : null
      } catch {
        return null
      }
    })
    /**
     * Return public manual title, page count, and source link, hiding provider internals from the
     * renderer.
     *
     * @param {Object} _event - Electron invoke event; unused when no renderer notification is needed.
     * @param {string} gameId - Stable library/media identity; Main resolves or validates it before accessing files.
     */
    ipcMain.handle('get-game-manual', async (_event, gameId) => {
      try {
        const game = guideGame(gameId)
        const manual = game ? await getGuideService().getManual(game) : null
        return manual
          ? { title: manual.title, pageCount: manual.leaves.length, sourceUrl: manual.sourceUrl }
          : null
      } catch {
        return null
      }
    })
    /**
     * Resolve a bounded manual page and register its local URL; optional-content errors yield null.
     *
     * @param {Object} _event - Electron invoke event; unused when no renderer notification is needed.
     * @param {Object} options2 - Named inputs for this operation.
     * @param {string} options2.gameId - Stable library/media identity; Main resolves or validates it before accessing files.
     * @param {number} options2.index - Zero-based selection, button, or page index.
     */
    ipcMain.handle('get-manual-page', async (_event, { gameId, index } = {}) => {
      try {
        const game = guideGame(gameId)
        return game ? mediaUrl(await getGuideService().getPage(game, index)) : null
      } catch {
        return null
      }
    })
    protocol.handle('game-media', serveMedia)
    /**
     * Scan library artwork with progress events and queue independent preview downloads; force
     * bypasses lookup cooldowns.
     *
     * @param {Object} event - Electron or DOM event associated with this operation.
     * @param {Object} options - Operation configuration; see destructured properties and defaults below.
     */
    ipcMain.handle('scan-and-scrape-games', async (event, options) => {
      const result = await getScraper().scan(
        getLocalGames(),
        /**
         * Complete the scan callback step owned by result; caller arguments and captured state determine this stage's result.
         *
         * @param {*} progress - Value supplied by the enclosing operation; interpreted in this callback's local scope.
         */
        (progress) => {
          if (!event.sender.isDestroyed())
            event.sender.send('scrape-progress', {
              ...progress,
              game: decorateGame(progress.game)
            })
        },
        { force: options?.force === true }
      )
      return { ...result, games: result.games.map(decorateGame) }
    })
    /**
     * Verify ROM/core/BIOS, prepare session config, spawn RetroArch, and keep the Promise pending
     * through session exit.
     */
    ipcMain.handle('launch-game', launchGame)
    /**
     * Refuse while a game is active, delete only platform BIOS candidates, then report physical
     * status.
     *
     * @param {Object} _event - Electron invoke event; unused when no renderer notification is needed.
     * @param {string} platform - Platform selector; OS helpers accept win32/linux, BIOS and IPC helpers accept a library console ID.
     */
    ipcMain.handle('delete-bios', async (_event, platform) => {
      if (launchInProgress) return { success: false, error: 'Stop the running game first.' }
      try {
        await deleteBios(retroarchDir, platform)
        return { success: true, status: biosStatus(retroarchDir, platform) }
      } catch (error) {
        return { success: false, error: error.message }
      }
    })
    /**
     * Open the BIOS picker and copy a user-supplied dump without replacing an existing file.
     */
    ipcMain.handle('upload-bios', uploadBios)
    /**
     * Create and open the platform BIOS directory through the OS file manager.
     */
    ipcMain.handle('open-bios-folder', openBiosFolder)

    createWindow()

    app.on(
      'activate',
      /**
       * Handle activate events for index.js; lifecycle cleanup or a one-shot subscription controls how long this callback remains active.
       */
      function () {
        // On macOS it's common to re-create a window in the app when the
        // dock icon is clicked and there are no other windows open.
        if (BrowserWindow.getAllWindows().length === 0) createWindow()
      }
    )
  }
)

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on(
  'window-all-closed',
  /**
   * Handle window-all-closed events for index.js; lifecycle cleanup or a one-shot subscription controls how long this callback remains active.
   */
  () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  }
)

app.on(
  'will-quit',
  /**
   * Handle will-quit events for index.js; lifecycle cleanup or a one-shot subscription controls how long this callback remains active.
   */
  () => {
    sessionBridge?.stop()
    globalShortcut.unregisterAll()
  }
)
