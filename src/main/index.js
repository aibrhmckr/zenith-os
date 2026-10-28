import {
  createSnapshot,
  mapCooperatively,
  createProgressPublisher
} from './services/workScheduling.js'
import { createHardwareDetector } from './services/hardwareDetector'
import { createCrashReporter, watchEmulator } from './services/crashResilience'
import { secureIpcHandle, hardenWebContents } from './services/securityBoundary'
import { stopForRestart } from './services/restartSession'
import { createFileBrowser } from './services/fileBrowser'
import { createPreferences, mediaPreferences } from './services/preferences'
import { app, shell, BrowserWindow, ipcMain, protocol, net, dialog, globalShortcut } from 'electron'
import fs from 'node:fs'
import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { basename, dirname, extname, join, parse, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { CONSOLE_EXTENSIONS } from '../shared/consoles'
import { createScraper } from './services/scraper'
import { mediaUrl, gameLogoUrl, serveMedia, revokeMediaDirectory } from './services/local-media'
import { createGuideService } from './services/guideService'
import { downloadRpcs3 } from './services/rpcs3Download'
import { installRpcs3Content } from './services/rpcs3Content'
import { scanRpcs3Games, isRpcs3ManagedPath } from './services/rpcs3Library'
import { createRpcs3Runtime } from './services/rpcs3Runtime'
import { createCoreManager, coreFilesFor } from './services/coreManager'
import { createLibraryStore } from './services/libraryStore'
import { biosDirectory, biosStatus, deleteBios } from './services/biosStatus'
import { gameMediaDirectory } from './services/mediaPaths'
import { startSessionBridge } from './services/sessionBridge'
import { createCoreCatalog, biosPlatformForCore } from './services/coreCatalog'
import { createGameImporter } from './services/gameImporter'
import { normalizeHotkeys } from '../shared/hotkeys'
import { runtimePaths, pathKey } from './services/platform'
import { seedBundledRetroArch } from './services/bundledRuntime'
import { createDownloadCenter } from './services/downloadCenter'
import { createApplicationUpdater } from './services/applicationUpdater'
import { updateInstalledEmulators } from './services/emulatorUpdates'
import { createSoftwareUpdates } from './services/softwareUpdates'
import { createWallpaperManager } from './services/wallpapers'

// Vite serves changing modules over HTTP. Bypass Chromium's persistent HTTP
// cache before the first session is created so stale/corrupt development cache
// entries cannot replace the document or modules. Keep preferences and media.
// Packaged/file-based launches retain their normal cache behavior.
if (is.dev && process.env.ELECTRON_RENDERER_URL) {
  app.commandLine.appendSwitch('disable-http-cache')
}

const hardwareDetector = createHardwareDetector({
  app,
  publish: (status) => {
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('hardware:changed', status)
  }
})
const crashReporter = createCrashReporter({ userData: app.getPath('userData') })

const downloads = createDownloadCenter({
  userData: app.getPath('userData'),
  publish: (tasks) => {
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('downloads:progress', tasks)
  }
})
let applicationUpdater = null
let applicationUpdateFallback = { status: app.isPackaged ? 'idle' : 'developer', ready: false }
let updateTimer = null
let emulatorUpdate = null
let softwareUpdates = null
/** Individual maintenance writes feed the Settings tracker; only its summary becomes a notification. */
function reportDownload(task) {
  if (softwareUpdates?.busy() && ['core', 'rpcs3', 'app', 'emulatorUpdate'].includes(task.kind)) {
    softwareUpdates.progress(task)
    return
  }
  downloads.report(task)
}

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
/** Standalone PS3 runtime, physically checked at status and launch time. */
const rpcs3 = createRpcs3Runtime({ userData: app.getPath('userData') })
/** A single maintenance lease covers picker, download, extraction and RPCS3 installer exit. */
let rpcs3Job = null
const rpcs3Status = () => ({
  ...rpcs3.status(),
  hostPlatform: process.platform,
  operation: rpcs3Job?.progress || null
})
async function maintainRpcs3(action, updating = false) {
  if (launchInProgress || rpcs3Job || (emulatorUpdate && !updating))
    return { success: false, error: 'Stop the running game or wait for RPCS3 setup to finish.' }
  const job = { controller: new AbortController(), progress: { phase: 'starting' } }
  rpcs3Job = job
  const progress = (value) => {
    job.progress = value
    reportDownload({
      id: 'rpcs3-setup',
      name: 'RPCS3',
      kind: 'rpcs3',
      status: 'active',
      ...value
    })
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('rpcs3-install-progress', value)
  }
  job.promise = (async () => {
    try {
      const result = await action({ signal: job.controller.signal, progress })
      if (!result.upToDate)
        reportDownload({
          id: 'rpcs3-setup',
          name: 'RPCS3',
          kind: 'rpcs3',
          status: result.success ? 'completed' : result.canceled ? 'interrupted' : 'failed',
          error: result.error
        })
      return result
    } catch (error) {
      reportDownload({
        id: 'rpcs3-setup',
        name: 'RPCS3',
        kind: 'rpcs3',
        status: 'failed',
        error: error.message
      })
      return { success: false, error: error.message, status: rpcs3.status() }
    } finally {
      rpcs3Job = null
      if (mainWindow && !mainWindow.isDestroyed())
        mainWindow.webContents.send('rpcs3-install-progress', null)
    }
  })()
  return job.promise
}
/** Publish a library invalidation after a successful PKG install, including reinstalls/updates. */
async function installRpcs3AndRefresh(options) {
  const result = await installRpcs3Content(options)
  if (result.success && options.kind === 'package') {
    const installed = scanRpcs3Games(rpcs3).find((game) => game.titleId === result.titleId)
    if (installed) getLibrary().add([installed.path])
    librarySnapshot.invalidate()
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('library-changed')
  }
  return result
}

/**
 * Main-owned hotkey persistence shared with the background input bridge; renderer audio/language
 * settings use localStorage separately.
 */
const preferenceStore = createPreferences(app.getPath('userData'))
const wallpapers = createWallpaperManager({
  userData: app.getPath('userData'),
  preferences: preferenceStore
})
/**
 * Normalized active keyboard/gamepad mapping; defaults survive a missing or damaged preferences
 * file.
 */
let hotkeys = normalizeHotkeys(null)
try {
  hotkeys = normalizeHotkeys(preferenceStore.get().hotkeys)
} catch {
  /* defaults */
}
/**
 * Host-bound core installer and physical-file verifier, shared by launch and status IPC.
 */
const cores = createCoreManager({
  retroarchDir,
  onProgress: (task) => reportDownload({ kind: 'core', ...task })
})
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
 * The single running emulator process (RetroArch or RPCS3); menu/resume/stop handlers act only on this child.
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
let sessionAwaitingRender = false
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
  if (sessionAwaitingRender) {
    mainWindow?.webContents.send('session-menu', false)
    return { success: true, waitingForRender: true }
  }
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
/** Supported regular-file extensions; ambiguous platform detection lives in the shared helper. */
const supportedExtensions = new Set(Object.values(CONSOLE_EXTENSIONS).flat())
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
async function guideGame(gameId) {
  return typeof gameId === 'string'
    ? (await getLocalGames()).find(
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
    onDownload: downloads.report,
    getPreferences: () => mediaPreferences(preferenceStore.get().media),
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
  const enriched =
    game.mediaDirectory && game.gameId && game.media ? game : getScraper().enrich(game)
  const cover = enriched.media.boxart || game.cover
  const backdrop = enriched.media.snap || enriched.media.titleScreen || game.backdrop || cover
  return {
    ...enriched,
    cover,
    backdrop,
    coverUrl: enriched.media.boxart ? mediaUrl(cover) : game.coverUrl,
    backdropUrl: mediaUrl(backdrop),
    titleScreenUrl: mediaUrl(enriched.media.titleScreen),
    logoUrl: gameLogoUrl(enriched),
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
const librarySnapshot = createSnapshot(scanLocalGames)
function getLocalGames(options) {
  return librarySnapshot.get(options)
}
async function scanLocalGames() {
  await fs.promises.mkdir(gamesDirectory, { recursive: true })
  const files = (await fs.promises.readdir(gamesDirectory, { withFileTypes: true })).filter(
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

  const local = await mapCooperatively(
    files
      .filter(
        /**
         * Retain only files entries satisfying local's local predicate; excluded values do not reach the next stage.
         *
         * @param {*} file - Value supplied by the enclosing operation; interpreted in this callback's local scope.
         */
        (file) =>
          supportedExtensions.has(extname(file.name).toLowerCase()) &&
          !getLibrary().excluded(join(gamesDirectory, file.name))
      )
      .sort(
        /**
         * Order files .filter( (file) => supportedExtensions.has(extname(file.name).toLowerCase()) && !getLibrar candidates deterministically before local consumes the preferred result.
         *
         * @param {*} a - Value supplied by the enclosing operation; interpreted in this callback's local scope.
         * @param {*} b - Value supplied by the enclosing operation; interpreted in this callback's local scope.
         */
        (a, b) => a.name.localeCompare(b.name)
      ),
    /**
     * Project each files .filter( (file) => supportedExtensions.has(extname(file.name).toLowerCase()) && !getLibrar entry for local; preserve input ordering in the derived collection.
     *
     * @param {*} file - Value supplied by the enclosing operation; interpreted in this callback's local scope.
     */
    (file) => {
      const { name } = parse(file.name)
      const gamePath = join(gamesDirectory, file.name)
      const system = getLibrary().platformFor(gamePath)
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
        platformOverride: getLibrary().platformOverride(gamePath),
        cover,
        backdrop: cover,
        coverUrl
      })
    }
  )
  for (const game of scanRpcs3Games(rpcs3)) {
    if (!getLibrary().excluded(game.path))
      local.push(decorateGame({ ...game, coverUrl: mediaUrl(game.cover) }))
  }
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
      .list((file) => paths.has(pathKey(file)) || isRpcs3ManagedPath(rpcs3, file))
      .filter(
        /**
         * Retain only getLibrary() .list() entries satisfying getLocalGames's local predicate; excluded values do not reach the next stage.
         *
         * @param {*} game - Value supplied by the enclosing operation; interpreted in this callback's local scope.
         */
        (game) => !paths.has(pathKey(game.path)) && !isRpcs3ManagedPath(rpcs3, game.path)
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
  if (emulatorUpdate || cores.busy() || softwareUpdates?.busy())
    return { success: false, error: 'Wait for emulator maintenance to finish.' }
  if (rpcs3Job) return { success: false, error: 'Wait for RPCS3 setup to finish.' }
  if (launchInProgress) return { success: false, error: 'A game is already running or launching.' }
  launchInProgress = true
  try {
    // Resolve the authoritative disk/override platform, never route using stale renderer labels.
    const launchGames = await getLocalGames({ fresh: true })
    const registered = launchGames.find((entry) => entry.path === request?.gamePath)
    if (registered && !isFile(registered.path))
      return { success: false, error: 'Game file is missing.' }
    if (registered) request = { ...request, consoleType: registered.systemShort }
    if (request?.consoleType === 'PS3') {
      const game = launchGames.find(
        (entry) => entry.path === request.gamePath && entry.systemShort === 'PS3'
      )
      if (!game) return { success: false, error: 'ps3_game_missing', platform: 'PS3' }
      const plan = rpcs3.prepareLaunch(game.path, await hardwareDetector.detect())
      if (!plan.success)
        return plan.error === 'rpcs3_config_failed' ? plan : { ...plan, status: rpcs3Status() }
      // Deliberately bypass RetroArch preparation, cores, BIOS and session.cfg for PS3.
      return await runEmulatorSession(event, plan)
    }
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
      !launchGames.some(
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
    const game = launchGames.find(
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
    return await runEmulatorSession(event, {
      executable,
      args: ['-L', corePath, gamePath, '-f', '--appendconfig', config],
      cwd: retroarchDir,
      label: 'RetroArch'
    })
  } catch (error) {
    return await showLaunchError(`Game could not start: ${error.message}`)
  } finally {
    launchInProgress = false
  }
}

/**
 * Own the common RetroArch/RPCS3 child lifecycle. Keep launch IPC pending until exit; hide Zenith
 * only after spawn succeeds, and bind the native controller helper to this child's actual PID.
 * @param {Object} event - Authorized launch IPC event.
 * @param {{executable:string,args:string[],cwd:string,label:string}} plan - Main-owned launch plan.
 */
function runEmulatorSession(event, { executable, args, cwd, label, env }) {
  // Keep the IPC request pending until exit so the UI cannot launch a second session.
  return new Promise(
    /**
     * Bridge launchGame's callback-based work into a Promise; settle it through the supplied resolve/reject functions.
     *
     * @param {*} resolve - Fulfill the pending operation.
     */
    (resolve) => {
      const waitForRender = label === 'RPCS3' && process.platform === 'win32'
      sessionAwaitingRender = waitForRender
      let startupTimer = null
      let announced = false
      const announce = () => {
        if (announced || finished) return
        announced = true
        clearTimeout(startupTimer)
        if (!event.sender.isDestroyed()) event.sender.send('game-started')
      }
      const revealGame = () => {
        if (finished || announced) return
        sessionAwaitingRender = false
        announce()
        // A late render signal must not dismiss a menu the user deliberately opened.
        if (!sessionMenuOpen && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.setAlwaysOnTop(false)
          mainWindow.hide()
          sessionBridge?.resume()
        }
      }
      if (waitForRender && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setKiosk(true)
        mainWindow.setFullScreen(true)
        mainWindow.setAlwaysOnTop(true, 'screen-saver')
        mainWindow.show()
        mainWindow.focus()
      }
      // spawn takes the executable separately from its arguments; no shell quoting is needed.
      let spawnError
      let child
      try {
        child = spawn(executable, args, {
          cwd,
          ...(env ? { env } : {}),
          shell: false,
          detached: true,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe']
        })
      } catch (error) {
        spawnError = error
        child = new EventEmitter()
      }
      activeChild = child
      scraper?.setPaused(true)
      child.stdout?.on(
        'data',
        /**
         * Handle data events for launchGame; lifecycle cleanup or a one-shot subscription controls how long this callback remains active.
         *
         * @param {*} data - Value supplied by the enclosing operation; interpreted in this callback's local scope.
         */
        (data) => console.log(`[${label} stdout] ${data.toString()}`)
      )
      child.stderr?.on(
        'data',
        /**
         * Handle data events for launchGame; lifecycle cleanup or a one-shot subscription controls how long this callback remains active.
         *
         * @param {*} data - Value supplied by the enclosing operation; interpreted in this callback's local scope.
         */
        (data) => console.log(`[${label} stderr] ${data.toString()}`)
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
        clearTimeout(startupTimer)
        activeChild = null
        scraper?.setPaused(false)
        try {
          sessionBridge?.stop()
        } catch (error) {
          console.warn('[Session cleanup]', error.message)
        }
        sessionBridge = null
        sessionMenuOpen = false
        sessionAwaitingRender = false
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
        resolve({ success: false, error: message.reason || 'emulator_crash', crash: message })
      }
      child.once(
        'spawn',
        /**
         * Handle spawn events for launchGame; lifecycle cleanup or a one-shot subscription controls how long this callback remains active.
         */
        () => {
          try {
            sessionBridge = startSessionBridge(
              child.pid,
              join(__dirname, '../../resources/gamepad-bridge.ps1'),
              () => {
                openSessionMenu()
              },
              hotkeys,
              mainWindow && !mainWindow.isDestroyed()
                ? mainWindow.getNativeWindowHandle()
                : undefined,
              { watchReady: waitForRender, onReady: revealGame }
            )
          } catch (error) {
            console.warn('[Input bridge]', error.message)
            void crashReporter.record({
              emulator: label,
              reason: 'input_bridge',
              error: error.message
            })
          }
          const menuDuringBoot = () => {
            openSessionMenu()
          }
          if (!waitForRender) revealGame()
          else {
            // Never leave an unresponsive loading mask if a custom title/driver prevents detection.
            startupTimer = setTimeout(menuDuringBoot, 120000)
            startupTimer.unref()
          }
          globalShortcut.register('F10', menuDuringBoot)
          globalShortcut.register(
            'Escape',
            /**
             * Complete the register callback step owned by launchGame; caller arguments and captured state determine this stage's result.
             */
            () => (sessionMenuOpen ? resumeSession() : menuDuringBoot())
          )
        }
      )
      const sentinel = watchEmulator(child, {
        label,
        reporter: crashReporter,
        hardware: hardwareDetector.snapshot(),
        finish
      })
      if (spawnError) sentinel.fail(spawnError)
    }
  )
}

/**
 * Create the isolated frameless fullscreen dashboard, reveal it when ready, and load Vite in
 * development or the packaged HTML in production.
 */
const dashboardUrl = () =>
  is.dev && process.env.ELECTRON_RENDERER_URL
    ? process.env.ELECTRON_RENDERER_URL
    : pathToFileURL(join(__dirname, '../renderer/index.html')).href
const handleIpc = secureIpcHandle(
  ipcMain,
  () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null),
  dashboardUrl
)

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
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      autoplayPolicy: 'no-user-gesture-required',
      sandbox: true
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

  hardenWebContents(mainWindow.webContents, (url) => shell.openExternal(url))

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
  async () => {
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
    handleIpc('get-media-preferences', () => mediaPreferences(preferenceStore.get().media))
    const fileBrowser = createFileBrowser({
      roots: [
        gamesDirectory,
        retroarchDir,
        app.getPath('userData'),
        app.getPath('desktop'),
        app.getPath('downloads')
      ],
      desktop: app.getPath('desktop'),
      downloads: app.getPath('downloads')
    })
    handleIpc('files:folder-summary', async (_event, token) => {
      try {
        return { success: true, ...(await fileBrowser.folderSummary(token)) }
      } catch (error) {
        return { success: false, error: error.message }
      }
    })
    handleIpc('files:preview', async (_event, token) => {
      try {
        return { success: true, ...(await fileBrowser.preview(token)) }
      } catch (error) {
        return { success: false, error: error.message }
      }
    })
    handleIpc('files:list', async (_event, request) => {
      try {
        return { success: true, ...(await fileBrowser.list(request)) }
      } catch (error) {
        return { success: false, error: error.message }
      }
    })
    handleIpc('wallpapers:list', () => wallpapers.list())
    handleIpc('wallpapers:delete', async (_event, options) => {
      try {
        return { success: true, wallpapers: await wallpapers.remove(options) }
      } catch (error) {
        return { success: false, error: error.message }
      }
    })
    handleIpc('wallpapers:update', async (_event, patch) => {
      try {
        return { success: true, wallpapers: await wallpapers.update(patch) }
      } catch (error) {
        return { success: false, error: error.message }
      }
    })
    handleIpc('wallpapers:import', async (_event, token) => {
      try {
        const [file] = await fileBrowser.consume('wallpaper', [token])
        return { success: true, wallpapers: await wallpapers.importFile(file) }
      } catch (error) {
        return { success: false, error: error.message }
      }
    })
    handleIpc('save-media-preferences', async (event, patch) => {
      try {
        if (
          !patch ||
          typeof patch !== 'object' ||
          Array.isArray(patch) ||
          Object.entries(patch).some(
            ([key, value]) =>
              ![
                'downloadCovers',
                'downloadBackgrounds',
                'downloadVideos',
                'downloadAudio'
              ].includes(key) || typeof value !== 'boolean'
          )
        )
          throw Error('Invalid media preferences')
        const saved = await preferenceStore.update((current) => ({
          media: { ...mediaPreferences(current.media), ...patch }
        }))
        const media = saved.media
        scraper?.cancelDisabledRequests()
        event.sender.send('library-changed')
        return { success: true, preferences: media }
      } catch (error) {
        return { success: false, error: error.message }
      }
    })
    handleIpc('get-hotkeys', () => hotkeys)
    /**
     * Normalize and atomically persist the combination, then update the running native bridge.
     *
     * @param {Object} _event - Electron invoke event; unused when no renderer notification is needed.
     * @param {*} value - Input value being normalized, displayed, or committed by this helper.
     */
    handleIpc('save-hotkeys', async (_event, value) => {
      try {
        const next = normalizeHotkeys(value)
        await preferenceStore.update({ hotkeys: next })
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
    handleIpc('quit-app', () => {
      activeChild?.kill()
      app.quit()
      return { success: true }
    })
    /**
     * Return current library records with local protocol URLs without waiting for network scraping.
     */
    handleIpc('get-local-games', () => getLocalGames({ fresh: true }))
    handleIpc('set-game-platform', async (_event, { gameId, platform } = {}) => {
      try {
        if (launchInProgress || rpcs3Job || emulatorUpdate)
          throw Error('Stop the running game or setup first.')
        const game = await guideGame(gameId)
        if (!game || game.rpcs3Installed) throw Error('Game platform cannot be changed.')
        getLibrary().setPlatform(game.path, platform)
        librarySnapshot.invalidate()
        const updated = (await getLocalGames({ fresh: true })).find(
          (entry) => entry.path === game.path
        )
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('library-changed')
        return { success: true, game: updated }
      } catch (error) {
        return { success: false, error: error.message }
      }
    })
    /**
     * Consume validated file-browser selections and copy them to the central library.
     */
    handleIpc('add-games', async (_event, tokens) => {
      try {
        const selection = { filePaths: await fileBrowser.consume('games', tokens) }
        const packages = selection.filePaths.filter(
          (file) => extname(file).toLowerCase() === '.pkg'
        )
        if (packages.length) {
          const installed = await maintainRpcs3(async (context) => {
            for (const file of packages) {
              await installRpcs3AndRefresh({ runtime: rpcs3, kind: 'package', file, ...context })
            }
            return { success: true }
          })
          if (!installed.success) return installed
        }
        const copied = await importGames(
          selection.filePaths.filter((file) => extname(file).toLowerCase() !== '.pkg')
        )
        getLibrary().add(copied)
        librarySnapshot.invalidate()
        return { success: true, count: copied.length + packages.length }
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
    handleIpc('delete-game', async (_event, gameId) => {
      if (launchInProgress) return { success: false, error: 'Stop the running game first.' }
      const game = await guideGame(gameId)
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
        librarySnapshot.invalidate()
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
    handleIpc('list-cores', () => coreCatalog.list())
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
    handleIpc('select-core', async (_event, { gameId, platform, core } = {}) => {
      try {
        const preparationError = await retroarchPreparation
        if (preparationError) throw preparationError
        if (launchInProgress || emulatorUpdate)
          throw Error('Stop the game or wait for emulator updates.')
        const game = gameId ? await guideGame(gameId) : null
        if ((game?.systemShort || platform) === 'PS3')
          throw Error('PS3 uses standalone RPCS3, not a Libretro core.')
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
    handleIpc('install-core', async (_event, system) => {
      try {
        if (launchInProgress || emulatorUpdate)
          throw Error('Stop the game or wait for emulator updates.')
        if (system === 'PS3') throw Error('PS3 uses standalone RPCS3, not a Libretro core.')
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
    handleIpc('downloads:list', () => downloads.snapshot())
    handleIpc('downloads:clear-history', () => downloads.clearHistory())
    // Snapshot survives clearing notifications and reopening Settings; development never loads the provider.
    handleIpc(
      'app-update:status',
      () => applicationUpdater?.snapshot() || applicationUpdateFallback
    )
    handleIpc('updates:check', () => {
      if (!app.isPackaged) return { success: true, developer: true, upToDate: true }
      if (!applicationUpdater)
        return { success: false, error: 'Updates require an installed release.' }
      void applicationUpdater.check()
      return { success: true }
    })
    handleIpc(
      'updates:install',
      (_event, options) =>
        applicationUpdater?.install(options?.confirmed) || {
          success: false,
          error: 'No update is ready.'
        }
    )
    handleIpc(
      'app-update:quit-and-install',
      (_event, options) =>
        applicationUpdater?.install(options?.confirmed) || {
          success: false,
          error: 'No update is ready.'
        }
    )
    const startEmulatorUpdate = (onProgress = () => {}) => {
      if (launchInProgress || rpcs3Job || emulatorUpdate || cores.busy())
        return { success: false, error: 'Stop the game or wait for current maintenance.' }
      // Only already-installed binaries are updated. Runtime data/config directories are never targets.
      emulatorUpdate = (async () => {
        const preparationError = await retroarchPreparation
        if (preparationError) throw preparationError
        const result = await updateInstalledEmulators({
          onProgress,
          retroarchDir,
          cores,
          report: (task) => reportDownload(task),
          updateRpcs3:
            process.platform === 'win32' && rpcs3.status().executableReady
              ? () =>
                  maintainRpcs3(
                    (context) => downloadRpcs3({ runtime: rpcs3, update: true, ...context }),
                    true
                  )
              : null
        })
        if (!result.success) throw Error(result.error)
        return result
      })()
        .catch((error) => {
          reportDownload({
            id: 'emulators-update',
            name: 'Emulators',
            kind: 'emulatorUpdate',
            status: 'failed',
            phase: 'failed',
            error: error.message
          })
          return { success: false, error: error.message }
        })
        .finally(() => {
          emulatorUpdate = null
        })
      return emulatorUpdate
    }
    handleIpc('emulators:update', () => {
      if (
        launchInProgress ||
        activeChild ||
        rpcs3Job ||
        emulatorUpdate ||
        cores.busy() ||
        softwareUpdates.busy()
      )
        return { success: false, error: 'Stop the game or wait for current maintenance.' }
      void startEmulatorUpdate()
      return { success: true }
    })
    softwareUpdates = createSoftwareUpdates({
      app,
      canStart: () =>
        !launchInProgress && !activeChild && !rpcs3Job && !emulatorUpdate && !cores.busy(),
      checkApp: () =>
        applicationUpdater?.check() || {
          success: false,
          error:
            'Zenith updates require an installed release. Installed emulators are still checked.'
        },
      updateEmulators: startEmulatorUpdate,
      report: downloads.report
    })
    handleIpc('software:update', () => softwareUpdates.start())
    handleIpc('get-rpcs3-status', rpcs3Status)
    handleIpc('download-rpcs3', (_event, options) => {
      if (emulatorUpdate) return { success: false, error: 'Emulators are updating.' }
      if (options?.confirmed !== true) return { success: false, canceled: true }
      return maintainRpcs3((context) => downloadRpcs3({ runtime: rpcs3, ...context }))
    })
    for (const [channel, kind] of [
      ['install-ps3-firmware', 'firmware'],
      ['install-ps3-package', 'package']
    ]) {
      handleIpc(channel, (_event, token) =>
        maintainRpcs3(async (context) => {
          // Both installers accept only one-use selections issued by the in-app browser.
          const [file] = await fileBrowser.consume(kind, [token])
          context.signal.throwIfAborted()
          return installRpcs3AndRefresh({
            runtime: rpcs3,
            kind,
            file,
            ...context
          })
        })
      )
    }
    handleIpc('cancel-rpcs3-install', () => {
      rpcs3Job?.controller.abort()
      return { success: true }
    })
    // Fixed main-owned directory only; never open an arbitrary renderer path.
    handleIpc('open-rpcs3-folder', async () => {
      try {
        rpcs3.ensureDirectories()
        const error = await shell.openPath(rpcs3.directory)
        return error ? { success: false, error } : { success: true }
      } catch (error) {
        return { success: false, error: error.message }
      }
    })
    handleIpc('hardware:get-status', () => hardwareDetector.detect())
    app.on('gpu-info-update', () => {
      void hardwareDetector.detect({ force: true })
    })
    app.on('child-process-gone', (_event, details) => {
      if (details.type === 'GPU' && details.reason !== 'clean-exit') {
        void crashReporter.record({
          emulator: 'Electron GPU',
          code: details.exitCode,
          reason: details.reason
        })
        void hardwareDetector.detect({ force: true })
      }
    })
    handleIpc('get-system-status', async () =>
      [
        ...new Set(
          (await getLocalGames()).map(
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
          if (platform === 'PS3') return { platform, emulator: 'RPCS3', runtime: rpcs3Status() }
          const core = coreCatalog.get(null, platform) || cores.find(platform)
          /**
           * Physically verified absolute core path; this is the same location the installer writes and
           * status IPC inspects.
           */
          const corePath = cores.pathFor(core)
          return {
            platform,
            core: corePath ? core : null,
            expectedCore: core || coreFilesFor()[platform]?.[0] || null,
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
    handleIpc('show-session-menu', () => {
      openSessionMenu()
      return { success: !!activeChild }
    })
    /**
     * Hide the session panel and restore emulator focus if a child is still running.
     */
    handleIpc('resume-session', () => (activeChild ? resumeSession() : { success: false }))
    /**
     * Request termination of the active emulator; normal exit handling restores the dashboard.
     */
    handleIpc('stop-session', () => {
      if (activeChild) activeChild.kill()
      return { success: true }
    })
    /**
     * Return resolved runtime paths and host information for diagnostics.
     */
    handleIpc('get-runtime-info', () => ({
      platform: process.platform,
      retroarchDir,
      rpcs3Directory: rpcs3.directory,
      gamesDirectory
    }))
    /**
     * Return enabled guide feature flags without making network requests.
     */
    handleIpc('get-guide-features', () => getGuideService().getFeatures())
    /**
     * Resolve a library game before returning optional cached/downloaded Wikipedia lore; failures
     * yield null.
     *
     * @param {Object} _event - Electron invoke event; unused when no renderer notification is needed.
     * @param {string} gameId - Stable library/media identity; Main resolves or validates it before accessing files.
     */
    handleIpc('get-game-lore', async (_event, gameId) => {
      try {
        const game = await guideGame(gameId)
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
    handleIpc('get-game-manual', async (_event, gameId) => {
      try {
        const game = await guideGame(gameId)
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
    handleIpc('get-manual-page', async (_event, { gameId, index } = {}) => {
      try {
        const game = await guideGame(gameId)
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
    const rescrapeJobs = new Map()
    handleIpc('games:rescrape', async (event, payload) => {
      const sender = event.sender
      try {
        // Renderer supplies identity/context, never authority to scrape an arbitrary path.
        const games = await getLocalGames()
        const game = games.find(
          (entry) => entry.id === payload?.id && entry.gameId === payload?.gameId
        )
        if (
          !game ||
          payload.platform !== game.systemShort ||
          payload.title !== game.title ||
          payload.path !== game.path
        )
          throw Error('Game is not in the library or its details changed. Refresh the library.')
        if (!rescrapeJobs.has(game.gameId)) {
          const task = getScraper()
            .rescrape(games, game.gameId, (progress) => {
              if (!sender.isDestroyed())
                sender.send('scrape-progress', {
                  ...progress,
                  game: decorateGame(progress.game)
                })
            })
            .then((result) => ({ success: true, ...result, game: decorateGame(result.game) }))
            .finally(() => rescrapeJobs.delete(game.gameId))
          rescrapeJobs.set(game.gameId, task)
        }
        return await rescrapeJobs.get(game.gameId)
      } catch (error) {
        console.log('[Scraper] Başarısız İndirmeler: IPC games:rescrape — ' + error.message)
        return { success: false, error: error.message }
      }
    })
    handleIpc('scan-and-scrape-games', async (event, options) => {
      // The dashboard just obtained a fresh local snapshot; standalone scan callers still rescan disk.
      const games = await getLocalGames({ fresh: options?.reuseSnapshot !== true })
      if (options?.gameId != null && !games.some((game) => game.gameId === options.gameId))
        throw Error('Game is not in the library.')
      const progress = createProgressPublisher((value) => {
        if (!event.sender.isDestroyed()) event.sender.send('scrape-progress', value)
      }, decorateGame)
      try {
        const result = await getScraper().scan(games, progress.report, {
          force: options?.force === true,
          gameId: options?.gameId || null
        })
        return { ...result, games: await mapCooperatively(result.games, decorateGame) }
      } finally {
        progress.flush()
      }
    })
    /**
     * Verify ROM/core/BIOS, prepare session config, spawn RetroArch, and keep the Promise pending
     * through session exit.
     */
    let sessionRequest = null,
      sessionCompletion = null,
      restarting = false
    handleIpc('launch-game', (event, request) => {
      if (restarting || activeChild || launchInProgress)
        return { success: false, error: 'A game is already running or launching.' }
      sessionRequest = request
      sessionCompletion = launchGame(event, request)
      return sessionCompletion
    })
    handleIpc('restart-session', async (event) => {
      if (restarting || !activeChild || !sessionRequest)
        return { success: false, error: 'No restartable session.' }
      restarting = true
      const request = sessionRequest
      try {
        await stopForRestart(activeChild, sessionCompletion)
        event.sender.send('game-loading')
        sessionCompletion = launchGame(event, request)
      } catch (error) {
        return { success: false, error: error.message }
      } finally {
        // Release only this transition's lock, before awaiting the new play session.
        restarting = false
      }
      return sessionCompletion
    })
    /**
     * Refuse while a game is active, delete only platform BIOS candidates, then report physical
     * status.
     *
     * @param {Object} _event - Electron invoke event; unused when no renderer notification is needed.
     * @param {string} platform - Platform selector; OS helpers accept win32/linux, BIOS and IPC helpers accept a library console ID.
     */
    handleIpc('delete-bios', async (_event, platform) => {
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
    handleIpc('upload-bios', uploadBios)
    /**
     * Create and open the platform BIOS directory through the OS file manager.
     */
    handleIpc('open-bios-folder', openBiosFolder)

    createWindow()
    if (app.isPackaged) {
      try {
        const module = await import('electron-updater')
        applicationUpdater = createApplicationUpdater({
          app,
          updater: module.autoUpdater || module.default.autoUpdater,
          downloads: { report: reportDownload },
          enabled: true,
          publish: (channel, state) => {
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, state)
          },
          canInstall: () =>
            !launchInProgress &&
            !activeChild &&
            !rpcs3Job &&
            !emulatorUpdate &&
            !cores.busy() &&
            !softwareUpdates?.busy()
        })
        updateTimer = setTimeout(() => void applicationUpdater.check(), 20000)
        updateTimer.unref()
      } catch (error) {
        applicationUpdateFallback = { status: 'error', ready: false, message: error.message }
        if (mainWindow && !mainWindow.isDestroyed())
          mainWindow.webContents.send('app-update:error', applicationUpdateFallback)
        reportDownload({
          id: 'zenith-update',
          name: 'Zenith OS',
          kind: 'app',
          status: 'failed',
          error: error.message
        })
      }
    }

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
    clearTimeout(updateTimer)
    globalShortcut.unregisterAll()
  }
)

// Let installers finish/roll back before flushing their final task history.
let persistenceFlushed = false
let quitPending = null
app.on('before-quit', (event) => {
  if (persistenceFlushed) return
  event.preventDefault()
  if (quitPending) return
  quitPending = (async () => {
    const pending = rpcs3Job
    pending?.controller.abort()
    await Promise.allSettled([pending?.promise, emulatorUpdate, cores.whenIdle()])
    await Promise.allSettled([downloads.flush(), scraper?.flush()])
    persistenceFlushed = true
    app.quit()
  })()
})
