// Real Electron Main/preload/React; synthetic files and mocked emulator/input processes only.
const { app, BrowserWindow, dialog, globalShortcut, shell } = require('electron')
const { EventEmitter } = require('node:events')
const cp = require('node:child_process')
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path')
const assert = require('node:assert/strict')
const { load } = require('js-yaml')
const { discImage } = require('./fixtures/disc-image.cjs')
const { coreBinary } = require('./fixtures/core-archive.cjs')
const { paramSfo } = require('./fixtures/ps3-sfo.cjs')
const art = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1sAAAAASUVORK5CYII=',
  'base64'
)
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zenith-rpcs3-ipc-'))
const profile = path.join(root, 'profile'),
  runtime = path.join(profile, 'emulators/rpcs3')
const exe = path.join(runtime, 'rpcs3.exe'),
  game = path.join(root, 'games', 'Blur (USA).iso')
fs.mkdirSync(path.dirname(game), { recursive: true })
fs.writeFileSync(game, discImage('PS3'))
const pkg = path.join(root, 'games', 'Package.pkg')
fs.writeFileSync(pkg, 'synthetic package')
app.getAppPath = () => root
const originalGetPath = app.getPath.bind(app)
app.getPath = (name) =>
  ['home', 'desktop', 'downloads'].includes(name) ? root : originalGetPath(name)
app.setPath('userData', profile)
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('force-prefers-reduced-motion')
const actions = []
for (const method of [
  'show',
  'hide',
  'restore',
  'focus',
  'setKiosk',
  'setFullScreen',
  'setAlwaysOnTop'
])
  BrowserWindow.prototype[method] = (...args) => actions.push([method, ...args])
const shortcuts = new Map()
globalShortcut.register = (key, fn) => {
  shortcuts.set(key, fn)
  return true
}
globalShortcut.unregister = (key) => shortcuts.delete(key)
globalShortcut.unregisterAll = () => shortcuts.clear()
const dialogs = []
dialog.showMessageBox = async (...args) => {
  dialogs.push(args.at(-1))
  return { response: 0 }
}
let opened
shell.openPath = async (dir) => {
  opened = dir
  return ''
}
let requests = 0
const mediaRequests = []
let picked = null
let installFails = false
let installExitCode = 0
dialog.showOpenDialog = async () => {
  throw Error('PS3 content must use the in-app browser')
}
globalThis.fetch = async (url) => {
  mediaRequests.push(url)
  requests++
  return new Response('', { status: 404 })
}
const spawns = [],
  commands = []
let emulator, bridge
cp.spawn = (command, args, options) => {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = new EventEmitter()
  child.stdin.writable = true
  child.stdin.write = (value) => commands.push(value)
  child.stdin.end = (value) => commands.push(value)
  child.kill = () => {
    child.killed = true
    child.emit('exit', 0)
    child.emit('close', 0)
  }
  spawns.push({ command, args, options, child })
  if (args[0] === '--headless') {
    assert.equal(command, exe)
    assert.equal(options.windowsHide, true)
    assert.equal(options.shell, false)
    setTimeout(() => {
      if (child.killed) return
      if (!installFails && args[1] === '--installpkg') {
        const titleDir = path.join(runtime, 'portable/dev_hdd0/game/NPUB12345')
        fs.mkdirSync(path.join(titleDir, 'USRDIR'), { recursive: true })
        fs.writeFileSync(path.join(titleDir, 'USRDIR/EBOOT.BIN'), 'synthetic boot')
        fs.writeFileSync(path.join(titleDir, 'ICON0.PNG'), art)
        fs.writeFileSync(path.join(titleDir, 'PIC1.PNG'), art)
        fs.writeFileSync(
          path.join(titleDir, 'PARAM.SFO'),
          paramSfo({ TITLE_ID: 'NPUB12345', TITLE: 'Installed Test Game', CATEGORY: 'HG' })
        )
        child.stdout.emit(
          'data',
          'Successfully installed input.pkg (title_id=NPUB12345, title=Test, version=1.00).'
        )
      } else if (!installFails) {
        const flash = path.join(runtime, 'portable/dev_flash')
        fs.mkdirSync(path.join(flash, 'sys/external'), { recursive: true })
        fs.mkdirSync(path.join(flash, 'vsh/etc'), { recursive: true })
        fs.writeFileSync(path.join(flash, 'sys/external/liblv2.sprx'), Buffer.from([83, 67, 69, 0]))
        fs.writeFileSync(path.join(flash, 'vsh/etc/version.txt'), 'release:04.9200:')
        child.stdout.emit('data', 'Successfully installed PS3 firmware version 4.92.')
      }
      child.emit('close', installExitCode)
    }, 500)
  } else if (command === 'powershell.exe') {
    bridge = child
    const script = Buffer.from(args.at(-1), 'base64').toString('utf16le')
    assert(script.includes('$EmulatorPid = 7333'), 'XInput bridge must watch RPCS3 PID')
  } else {
    assert.equal(command, exe, 'PS3 must never start RetroArch')
    const config = load(fs.readFileSync(path.join(runtime, 'portable/config/config.yml'), 'utf8'))
    assert.equal(config.Core['SPU Cache'], true, 'Settings must be on disk before spawn')
    assert.equal(config.Video['Disable On-Disk Shader Cache'], false)
    const input = load(
      fs.readFileSync(
        path.join(runtime, 'portable/config/input_configs/global/Default.yml'),
        'utf8'
      )
    )
    assert.equal(input['Player 1 Input'].Handler, 'XInput')
    assert.equal(input['Player 1 Input'].Config.Cross, 'A')
    child.pid = 7333
    emulator = child
    setTimeout(() => child.emit('spawn'), 20)
  }
  return child
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
async function run(win) {
  const ev = (code) => win.webContents.executeJavaScript(code)
  const wait = async (code) => {
    for (let i = 0; i < 200; i++) {
      if (await ev(code)) return
      await delay(20)
    }
    throw Error('Timeout: ' + code)
  }
  const call = `window.electronAPI.launchGame(${JSON.stringify(game)}, 'PS3')`
  const click = (selector) =>
    ev(`document.querySelector(${JSON.stringify(selector)}).click();undefined`)
  await wait("document.querySelectorAll('[data-game-card]').length===2")
  assert.equal((await ev(call)).error, 'missing_rpcs3')
  assert.equal(
    (await ev(`window.electronAPI.launchGame(${JSON.stringify(pkg)},'PS3')`)).error,
    'ps3_package_not_installed'
  )
  assert.equal(
    (
      await ev(
        `window.electronAPI.launchGame(${JSON.stringify(path.join(root, 'outside.iso'))},'PS3')`
      )
    ).error,
    'ps3_game_missing'
  )
  assert.equal(spawns.length, 0)
  assert.equal(dialogs.length, 0, 'Missing setup uses recoverable UI, not native error dialog')
  let systems = await ev('window.electronAPI.getSystemStatus()')
  assert.equal(systems[0].emulator, 'RPCS3')
  assert.equal(systems[0].runtime.ready, false)
  assert.equal((await ev("window.electronAPI.installCore('PS3')")).success, false)
  assert.equal(
    (await ev("window.electronAPI.selectCore({platform:'PS3',core:'mgba_libretro.dll'})")).success,
    false
  )
  await ev(
    "document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ContextMenu',code:'ContextMenu',bubbles:true}));undefined"
  )
  await wait("!!document.querySelector('[data-system-page]')")
  await click('[data-system-page]')
  await wait("!!document.querySelector('[data-core-platform=PS3] [data-rpcs3-status]')")
  assert.equal(
    await ev("!!document.querySelector('[data-core-platform=PS3] [data-install-core]')"),
    false
  )
  assert.equal(
    await ev("!!document.querySelector('[data-core-platform=PS3] [data-browse-cores]')"),
    false
  )
  await click('[data-modal-close]')
  await wait("!!document.querySelector('[data-console-modal=settings]')")
  await click('[data-modal-close]')
  await wait("!document.querySelector('dialog[open]')")
  // Manual correction is available through Q and remains authoritative at launch.
  const isoGame = (await ev('window.electronAPI.getLocalGames()')).find((g) => g.path === game)
  assert.equal(
    (await ev(`window.electronAPI.setGamePlatform(${JSON.stringify(isoGame.gameId)},'PS2')`))
      .success,
    true
  )
  await delay(100)
  await ev(
    "document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'q',code:'KeyQ',bubbles:true}));undefined"
  )
  await wait("!!document.querySelector('[data-change-platform]')")
  await click('[data-change-platform]')
  await wait("!!document.querySelector('[data-platform-choice=PS3]')")
  await click('[data-platform-choice=PS3]')
  await wait("!!document.querySelector('[data-console-modal=options]')")
  await click('[data-modal-close]')
  assert.equal(
    (await ev('window.electronAPI.getLocalGames()')).find((g) => g.path === game).systemShort,
    'PS3'
  )
  assert.equal(
    (await ev(`window.electronAPI.launchGame(${JSON.stringify(game)},'PS2')`)).error,
    'missing_rpcs3',
    'Stale PS2 renderer label must never route the PS3 ISO into RetroArch'
  )
  await click('[data-launch-game]')
  await wait("!!document.querySelector('[data-console-modal=rpcs3]')")
  await wait("document.activeElement?.hasAttribute('data-rpcs3-refresh')")
  await ev('window.electronAPI.openRpcs3Folder()')
  assert.equal(opened, runtime)
  assert(fs.statSync(path.join(runtime, 'portable')).isDirectory())
  const beforeRequests = requests
  assert.equal((await ev('window.electronAPI.downloadRpcs3(false)')).canceled, true)
  assert.equal(requests, beforeRequests, 'No network before consent')
  await click('[data-rpcs3-download]')
  await wait("!!document.querySelector('[data-rpcs3-consent]')")
  assert.equal(requests, beforeRequests, 'Opening consent is not download authorization')
  await click('[data-rpcs3-confirm]')
  await wait("!!document.querySelector('[data-rpcs3-status] [role=alert]')")
  assert(requests > beforeRequests, 'Confirmed download reaches service')
  assert.equal((await ev('window.electronAPI.getRpcs3Status()')).executableReady, false)
  fs.writeFileSync(exe, coreBinary('rpcs3.exe'))
  assert.equal((await ev(call)).error, 'missing_ps3_firmware')
  await click('[data-rpcs3-refresh]')
  await wait("!document.querySelector('[data-rpcs3-firmware]').disabled")
  await click('[data-rpcs3-firmware]')
  await wait("!!document.querySelector('[data-file-browser]')")
  await click('[data-console-modal=fileBrowser] [data-modal-close]')
  await wait("!document.querySelector('[data-rpcs3-firmware]').disabled")
  assert.equal(spawns.length, 0, 'Canceled picker never spawns')
  assert.equal(
    await ev("document.activeElement?.hasAttribute('data-rpcs3-firmware')"),
    true,
    'Picker cancellation restores its launch button'
  )
  picked = path.join(root, 'PS3UPDAT.PUP')
  const pup = Buffer.alloc(128)
  pup.write('SCEUF')
  fs.writeFileSync(picked, pup)
  const chooseFirmware = async () => {
    await click('[data-rpcs3-firmware]')
    await wait("!!document.querySelector('[data-file-location=desktop]')")
    await click('[data-file-location=desktop]')
    await wait("!!document.querySelector('[data-file-entry]')")
    await wait('!!document.querySelector(\'[data-file-name="PS3UPDAT.PUP"]\')')
    assert.equal(
      await ev(
        `!!document.querySelector('[data-file-name="selected-game.pkg"], [data-file-name="Blur (USA).iso"]')`
      ),
      false
    )
    await click('[data-file-name="PS3UPDAT.PUP"]')
  }
  await chooseFirmware()
  await wait("!!document.querySelector('[data-rpcs3-cancel]')")
  assert.equal((await ev(call)).success, false, 'Maintenance blocks game launch')
  assert.equal(
    (await ev('window.electronAPI.installPs3Package()')).success,
    false,
    'Maintenance serialized'
  )
  await wait(
    "!!document.querySelector('[data-rpcs3-launch]') && !document.querySelector('[data-rpcs3-launch]').disabled"
  )
  assert.equal((await ev('window.electronAPI.getRpcs3Status()')).firmware.ready, true)
  assert.equal(spawns[0].args[1], '--installfw')
  assert.equal(path.isAbsolute(spawns[0].args[2]), true)
  assert(fs.existsSync(picked), 'User input stays intact')
  fs.unlinkSync(path.join(runtime, 'portable/dev_flash/sys/external/liblv2.sprx'))
  installFails = true
  await chooseFirmware()
  await wait("!!document.querySelector('[data-rpcs3-status] [role=alert]')")
  assert.match(
    await ev("document.querySelector('[data-rpcs3-status] [role=alert]').textContent"),
    /valid installed firmware/
  )
  assert.equal((await ev('window.electronAPI.getRpcs3Status()')).operation, null)
  installFails = false
  installExitCode = 3221226505
  await chooseFirmware()
  await wait(
    "!document.querySelector('[data-rpcs3-firmware]').disabled && !!document.querySelector('[data-rpcs3-launch]')"
  )
  assert.equal(
    await ev("!!document.querySelector('[data-rpcs3-status] [role=alert]')"),
    false,
    'Teardown crash after valid firmware clears previous error'
  )
  assert.equal((await ev('window.electronAPI.getRpcs3Status()')).firmware.ready, true)
  const configFile = path.join(runtime, 'portable/config/config.yml')
  fs.mkdirSync(path.dirname(configFile), { recursive: true })
  fs.writeFileSync(configFile, '[invalid yaml')
  const spawnCount = spawns.length
  const failedConfig = await ev(call)
  assert.equal(failedConfig.error, 'rpcs3_config_failed')
  assert.equal(
    failedConfig.status,
    undefined,
    'Configuration error must not open a misleading Ready panel'
  )
  assert.equal(spawns.length, spawnCount, 'Invalid config must stop before spawn')
  fs.writeFileSync(configFile, '{}')
  installExitCode = 0
  picked = path.join(root, 'selected-game.pkg')
  const pkgBytes = Buffer.alloc(256)
  pkgBytes.writeUInt32BE(0x7f504b47, 0)
  pkgBytes.write('UP0001-NPUB12345_00-FIXTURE0000000000', 0x30)
  fs.writeFileSync(picked, pkgBytes)
  await click('[data-rpcs3-package]')
  await wait("!!document.querySelector('[data-file-location=desktop]')")
  await click('[data-file-location=desktop]')
  await wait("!!document.querySelector('[data-file-entry]')")
  await wait('!!document.querySelector(\'[data-file-name="selected-game.pkg"]\')')
  await click('[data-file-name="selected-game.pkg"]')
  await wait(
    "!document.querySelector('[data-rpcs3-package]').disabled && document.querySelectorAll('[data-game-card]').length===3"
  )
  let installedGames = await ev('window.electronAPI.getLocalGames()')
  const installedGame = installedGames.find((game) => game.titleId === 'NPUB12345')
  assert.equal(installedGame.title, 'Installed Test Game')
  assert.equal(
    installedGame.path,
    path.join(runtime, 'portable/dev_hdd0/game/NPUB12345/USRDIR/EBOOT.BIN')
  )
  assert.equal(installedGame.systemShort, 'PS3')
  assert.equal(
    installedGame.cover,
    path.join(runtime, 'portable/dev_hdd0/game/NPUB12345/ICON0.PNG')
  )
  assert.equal(
    installedGame.backdrop,
    path.join(runtime, 'portable/dev_hdd0/game/NPUB12345/PIC1.PNG')
  )
  assert.match(installedGame.coverUrl, /^game-media:/)
  assert.match(installedGame.backdropUrl, /^game-media:/)
  assert.notEqual(installedGame.coverUrl, installedGame.backdropUrl)
  // Add Game routes packages through the same installer, and a reinstall never duplicates the title.
  const imported = await ev(
    `(async()=>{const listing=await window.electronAPI.listFiles({kind:'games',path:${JSON.stringify(path.dirname(picked))}});return window.electronAPI.addGames([listing.entries.find(e=>e.name===${JSON.stringify(path.basename(picked))}).token])})()`
  )
  assert.equal(imported.success, true)
  assert.equal(
    (await ev('window.electronAPI.getLocalGames()')).filter((g) => g.titleId === 'NPUB12345')
      .length,
    1
  )
  assert(!fs.existsSync(path.join(root, 'games', 'selected-game.pkg')))
  assert(fs.existsSync(picked), 'Original PKG remains untouched')
  await wait("!document.querySelector('[data-rpcs3-package]').disabled")
  await ev('window.stopped=0;window.electronAPI.onGameStopped(()=>window.stopped++);undefined')
  await click('[data-rpcs3-launch]')
  for (let i = 0; i < 150 && !bridge; i++) await delay(20)
  assert(bridge, 'Native bridge started after RPCS3 spawn')
  assert.equal(JSON.parse(commands[0]).watchReady, true)
  assert(
    !actions.some((a) => a[0] === 'hide'),
    'Compilation remains behind Zenith until render readiness'
  )
  bridge.stdout.emit('data', 'home\n')
  await wait("!!document.querySelector('[data-console-modal=session]')")
  assert.equal((await ev('window.electronAPI.resumeSession()')).waitingForRender, true)
  await wait("!document.querySelector('[data-console-modal=session]')")
  assert(!actions.some((a) => a[0] === 'hide'), 'Resume during compilation must retain the mask')
  bridge.stdout.emit('data', 'rea')
  assert(!actions.some((a) => a[0] === 'hide'))
  bridge.stdout.emit('data', 'dy\n')
  assert(
    actions.some((a) => a[0] === 'hide'),
    'Ready render surface releases loading mask'
  )
  const launch = spawns.find((entry) => entry.args[0] === '--no-gui')
  assert.deepEqual(launch.args, ['--no-gui', game])
  assert.equal(launch.options.cwd, runtime)
  assert.equal(launch.options.shell, false)
  assert.equal(launch.options.detached, true)
  assert.equal((await ev(call)).success, false, 'One active session at a time')
  assert.deepEqual(JSON.parse(commands[0]).pad, [8, 9])
  bridge.stdout.emit('data', 'home\n')
  await wait("!!document.querySelector('[data-console-modal=session]')")
  await wait("document.activeElement?.hasAttribute('data-initial-focus')")
  assert(actions.some((a) => a[0] === 'setKiosk' && a[1] === true))
  assert(actions.some((a) => a[0] === 'setAlwaysOnTop' && a[1] === true && a[2] === 'screen-saver'))
  assert.equal(commands.at(-1), 'focus-zenith\n')
  await ev(
    "document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',code:'ArrowDown',bubbles:true}));undefined"
  )
  await wait("document.activeElement===document.querySelectorAll('[data-session-option]')[1]")
  await ev('window.electronAPI.resumeSession()')
  await wait("!document.querySelector('[data-console-modal=session]')")
  assert.equal(commands.at(-1), 'resume\n')
  assert(actions.some((a) => a[0] === 'setAlwaysOnTop' && a[1] === false))
  assert(!emulator.killed)
  // Restart twice: each old child closes before a fresh --no-gui process starts.
  for (let restart = 0; restart < 2; restart++) {
    const previous = emulator
    bridge.stdout.emit('data', 'home\n')
    await wait("!!document.querySelector('[data-restart-session]')")
    await click('[data-restart-session]')
    for (let i = 0; i < 200 && emulator === previous; i++) await delay(20)
    assert(previous.killed, 'Previous process must be terminated')
    assert.notEqual(emulator, previous, 'Restart creates a fresh process')
    await delay(80)
    bridge.stdout.emit('data', 'ready\n')
    await delay(40)
  }
  await ev('window.electronAPI.stopSession()')
  await wait('window.stopped===3')
  assert(emulator.killed)
  assert(!shortcuts.has('F10'))
  assert(commands.includes('stop\n'))
  // Unexpected exit restores UI and clears serialization for the next launch.
  await delay(80)
  await ev(`window.result=null;void ${call}.then(r=>window.result=r);undefined`)
  await delay(100)
  emulator.emit('exit', 1)
  emulator.emit('close', 1)
  await wait('window.result!==null')
  assert.equal((await ev('window.result')).error, 'emulator_crash')
  assert.equal(
    dialogs.length,
    0,
    'Runtime crashes use the React alert instead of a blocking native dialog'
  )
  await ev(`window.result=null;void ${call}.then(r=>window.result=r);undefined`)
  await delay(100)
  emulator.emit('error', new Error('synthetic spawn failure'))
  emulator.emit('close', -1)
  await wait('window.result!==null')
  assert.equal((await ev('window.result')).error, 'emulator_crash')
  // The existing launch pipeline authorizes and boots the installed EBOOT directly.
  await ev(
    `window.result=null;void window.electronAPI.launchGame(${JSON.stringify(installedGame.path)},'PS3').then(r=>window.result=r);undefined`
  )
  await delay(100)
  assert.deepEqual(spawns.filter((entry) => entry.args[0] === '--no-gui').at(-1).args, [
    '--no-gui',
    installedGame.path
  ])
  emulator.emit('exit', 0)
  emulator.emit('close', 0)
  await wait('window.result!==null')
  // Manual scan discovers an independently installed title and persists its metadata.
  const manualDir = path.join(runtime, 'portable/dev_hdd0/game/NPEB12345')
  fs.mkdirSync(path.join(manualDir, 'USRDIR'), { recursive: true })
  fs.writeFileSync(path.join(manualDir, 'USRDIR/EBOOT.BIN'), 'synthetic boot')
  fs.writeFileSync(
    path.join(manualDir, 'PARAM.SFO'),
    paramSfo({ TITLE_ID: 'NPEB12345', TITLE: 'Manual Scan Game', CATEGORY: 'HG' })
  )
  const scanned = await ev('window.electronAPI.scanAndScrapeGames({force:false})')
  assert.equal(scanned.games.filter((g) => g.rpcs3Installed).length, 2)
  assert.equal(scanned.games.find((g) => g.titleId === 'NPUB12345').gameId, installedGame.gameId)
  assert(fs.readFileSync(path.join(profile, 'games.json'), 'utf8').includes('Manual Scan Game'))
  // Q menu rescans this installed PS3 title through the same IPC path as other platforms.
  await wait("!document.querySelector('dialog[open]')")
  await ev('document.querySelector(\'[data-game-id="rpcs3-NPUB12345"]\').focus();undefined')
  await delay(50)
  await ev(
    "document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'q',code:'KeyQ',bubbles:true}));undefined"
  )
  await wait("!!document.querySelector('[data-rescrape-game]:not(:disabled)')")
  const requestsBefore = mediaRequests.length
  await click('[data-rescrape-game]')
  await wait("!document.querySelector('dialog[open]')")
  for (let i = 0; i < 100 && mediaRequests.length === requestsBefore; i++) await delay(20)
  assert(mediaRequests.length > requestsBefore, 'Q action must issue fresh PS3 media requests')
  await delay(100)
  assert.equal(
    (await ev('window.electronAPI.getLocalGames()')).find((g) => g.gameId === installedGame.gameId)
      .backdrop,
    installedGame.backdrop
  )
  await assert.rejects(
    ev("window.electronAPI.scanAndScrapeGames({force:true,gameId:'unknown'})"),
    /not in the library/
  )
  // Removing or invalidating installed content must remove it even if a PKG import registered it.
  fs.unlinkSync(installedGame.path)
  assert(
    !(await ev('window.electronAPI.getLocalGames()')).some((g) => g.gameId === installedGame.gameId)
  )
  fs.unlinkSync(exe)
  assert.equal((await ev('window.electronAPI.getRpcs3Status()')).ready, false)
  assert.equal((await ev(call)).error, 'missing_rpcs3')
  assert(!fs.existsSync(path.join(root, 'emulators/retroarch/retroarch.exe')))
  console.log(
    'PASS: PS3 physical setup status, IPC/UI recovery, standalone argv, RPCS3 PID bridge, focus/resume/stop, failures and retry; no RetroArch required'
  )
}
const timer = setTimeout(() => {
  console.error('RPCS3 test timeout')
  app.exit(1)
}, 90000)
app.once('browser-window-created', (_event, win) => {
  win.webContents.setBackgroundThrottling(false)
  win.webContents.once('did-finish-load', async () => {
    try {
      await run(win)
      clearTimeout(timer)
      app.exit(0)
    } catch (error) {
      console.error(error)
      console.log(await win.webContents.executeJavaScript('document.body.innerText'))
      clearTimeout(timer)
      app.exit(1)
    }
  })
})
require('../out/main/index.js')
