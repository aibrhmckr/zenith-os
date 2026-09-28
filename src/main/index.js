import { app, shell, BrowserWindow, ipcMain, protocol, net, dialog, globalShortcut } from 'electron'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { basename, dirname, extname, join, parse } from 'node:path'
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

const { gamesDirectory, retroarchDir, retroarchExecutable } = runtimePaths({
  packaged: app.isPackaged,
  appPath: app.getAppPath(),
  executable: app.getPath('exe'),
  userData: app.getPath('userData'),
  portableDirectory: process.env.PORTABLE_EXECUTABLE_DIR
})
const importGames = createGameImporter(gamesDirectory)
const hotkeyFile = join(app.getPath('userData'), 'zenith-preferences.json')
let hotkeys = normalizeHotkeys(null)
try {
  hotkeys = normalizeHotkeys(JSON.parse(fs.readFileSync(hotkeyFile, 'utf8')).hotkeys)
} catch {
  /* defaults */
}
const cores = createCoreManager({ retroarchDir })
const coreCatalog = createCoreCatalog({ retroarchDir, userData: app.getPath('userData') })
let library
const getLibrary = () => (library ||= createLibraryStore(app.getPath('userData')))
let activeChild = null
let sessionBridge = null
let sessionMenuOpen = false
const deleting = new Set()
function openSessionMenu() {
  if (!activeChild || !mainWindow || mainWindow.isDestroyed() || sessionMenuOpen) return
  sessionMenuOpen = true
  mainWindow.setAlwaysOnTop(true)
  mainWindow.show()
  mainWindow.focus()
  mainWindow.webContents.send('session-menu', true)
}
function resumeSession() {
  sessionMenuOpen = false
  mainWindow?.setAlwaysOnTop(false)
  mainWindow?.webContents.send('session-menu', false)
  mainWindow?.hide()
  sessionBridge?.resume()
  return { success: true }
}
let mainWindow
let launchInProgress = false
const consoleByExtension = new Map(
  Object.entries(CONSOLE_EXTENSIONS).flatMap(([system, extensions]) =>
    extensions.map((extension) => [extension, system])
  )
)
const localCovers = new Map()
let scraper
let guideService
function getGuideService() {
  guideService ||= createGuideService({
    userData: app.getPath('userData'),
    features: { manualsEnabled: true, loreEnabled: true }
  })
  return guideService
}
function guideGame(gameId) {
  return typeof gameId === 'string' ? getLocalGames().find((game) => game.gameId === gameId) : null
}
function getScraper() {
  scraper ||= createScraper({
    userData: app.getPath('userData'),
    onMediaUpdated: (game) => {
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed())
        mainWindow.webContents.send('game-media-updated', decorateGame(game))
    }
  })
  return scraper
}

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

function getLocalGames() {
  fs.mkdirSync(gamesDirectory, { recursive: true })
  const files = fs
    .readdirSync(gamesDirectory, { withFileTypes: true })
    .filter((file) => file.isFile())
  const fileNames = new Map(files.map((file) => [pathKey(file.name), file.name]))

  const local = files
    .filter(
      (file) =>
        consoleByExtension.has(extname(file.name).toLowerCase()) &&
        !getLibrary().excluded(join(gamesDirectory, file.name))
    )
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((file) => {
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
    })
  const paths = new Set(local.map((game) => pathKey(game.path)))
  return [
    ...local,
    ...getLibrary()
      .list()
      .filter((game) => !paths.has(pathKey(game.path)))
      .map((game) => decorateGame({ ...game, coverUrl: mediaUrl(game.cover) }))
  ]
    .filter((game) => !deleting.has(game.gameId))
    .sort((a, b) => a.title.localeCompare(b.title))
}

function isFile(filePath) {
  return fs.statSync(filePath, { throwIfNoEntry: false })?.isFile() === true
}

function getBiosDirectory(platform) {
  return biosDirectory(retroarchDir, platform)
}

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

async function launchGame(event, request) {
  if (launchInProgress) return { success: false, error: 'A game is already running or launching.' }
  launchInProgress = true
  try {
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
      !getLocalGames().some((game) => game.path === gamePath && game.systemShort === consoleType)
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
    const game = getLocalGames().find((game) => game.path === gamePath)
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
    const config = join(runtime, 'session.cfg')
    const quote = (value) => '"' + value.replace(/\\/g, '/').replace(/"/g, '') + '"'
    fs.writeFileSync(
      config,
      [
        'pause_nonactive = true',
        'config_save_on_exit = false',
        'input_menu_toggle_gamepad_combo = "0"',
        'input_menu_toggle_btn = "nul"',
        'input_menu_toggle = "nul"',
        'input_exit_emulator = "nul"',
        'input_quit_gamepad_combo = "0"',
        'system_directory = ' + quote(join(retroarchDir, 'system')),
        'savefile_directory = ' + quote(saveDir),
        'savestate_directory = ' + quote(stateDir)
      ].join('\n')
    )

    // Keep the IPC request pending until exit so the UI cannot launch a second session.
    return await new Promise((resolve) => {
      const corePath = join('cores', core)
      // spawn takes the executable separately from its arguments; no shell quoting is needed.
      const child = spawn(executable, ['-L', corePath, gamePath, '-f', '--appendconfig', config], {
        cwd: retroarchDir,
        shell: false,
        detached: true,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      activeChild = child
      child.stdout.on('data', (data) => console.log(`[RetroArch stdout] ${data.toString()}`))
      child.stderr.on('data', (data) => console.log(`[RetroArch stderr] ${data.toString()}`))
      let finished = false
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
      child.once('spawn', () => {
        if (!event.sender.isDestroyed()) event.sender.send('game-started')
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide()
        sessionBridge = startSessionBridge(
          child.pid,
          join(__dirname, '../../resources/gamepad-bridge.ps1'),
          openSessionMenu,
          hotkeys
        )
        globalShortcut.register('F10', openSessionMenu)
        globalShortcut.register('Escape', () =>
          sessionMenuOpen ? resumeSession() : openSessionMenu()
        )
      })
      child.once('error', (error) => {
        void finish(`RetroArch could not start: ${error.message}`)
      })
      const onExit = (code, signal) => {
        void finish(
          code === 0 || child.killed ? null : `RetroArch exited unexpectedly (${signal || code}).`
        )
      }
      child.once('exit', onExit)
      child.once('close', onExit)
    })
  } catch (error) {
    return await showLaunchError(`Game could not start: ${error.message}`)
  } finally {
    launchInProgress = false
  }
}

function createWindow() {
  // Create the browser window.
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 800,
    show: false,
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

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

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
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  protocol.handle('game-cover', (request) => {
    const cover = localCovers.get(request.url)
    return cover ? net.fetch(pathToFileURL(cover).href) : new Response(null, { status: 404 })
  })
  ipcMain.handle('get-hotkeys', () => hotkeys)
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
  ipcMain.handle('quit-app', () => {
    activeChild?.kill()
    app.quit()
    return { success: true }
  })
  ipcMain.handle('get-local-games', () => getLocalGames())
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
  ipcMain.handle('list-cores', () => coreCatalog.list())
  ipcMain.handle('select-core', async (_event, { gameId, platform, core } = {}) => {
    try {
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
  ipcMain.handle('install-core', (_event, system) => cores.install(system))
  ipcMain.handle('get-system-status', () =>
    [...new Set(getLocalGames().map((game) => game.systemShort))].map((platform) => ({
      platform,
      core: coreCatalog.get(null, platform) || cores.find(platform),
      bios: biosStatus(retroarchDir, platform)
    }))
  )
  ipcMain.handle('show-session-menu', () => {
    openSessionMenu()
    return { success: !!activeChild }
  })
  ipcMain.handle('resume-session', () => (activeChild ? resumeSession() : { success: false }))
  ipcMain.handle('stop-session', () => {
    if (activeChild) activeChild.kill()
    return { success: true }
  })
  ipcMain.handle('get-runtime-info', () => ({
    platform: process.platform,
    retroarchDir,
    gamesDirectory
  }))
  ipcMain.handle('get-guide-features', () => getGuideService().getFeatures())
  ipcMain.handle('get-game-lore', async (_event, gameId) => {
    try {
      const game = guideGame(gameId)
      return game ? await getGuideService().getLore(game) : null
    } catch {
      return null
    }
  })
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
  ipcMain.handle('get-manual-page', async (_event, { gameId, index } = {}) => {
    try {
      const game = guideGame(gameId)
      return game ? mediaUrl(await getGuideService().getPage(game, index)) : null
    } catch {
      return null
    }
  })
  protocol.handle('game-media', serveMedia)
  ipcMain.handle('scan-and-scrape-games', async (event, options) => {
    const result = await getScraper().scan(
      getLocalGames(),
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
  ipcMain.handle('launch-game', launchGame)
  ipcMain.handle('delete-bios', async (_event, platform) => {
    if (launchInProgress) return { success: false, error: 'Stop the running game first.' }
    try {
      await deleteBios(retroarchDir, platform)
      return { success: true, status: biosStatus(retroarchDir, platform) }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })
  ipcMain.handle('upload-bios', uploadBios)
  ipcMain.handle('open-bios-folder', openBiosFolder)

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.

app.on('will-quit', () => {
  sessionBridge?.stop()
  globalShortcut.unregisterAll()
})
