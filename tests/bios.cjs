const { coreBinary } = require('./fixtures/core-archive.cjs')
// Synthetic BIOS bytes only. Tests diagnosis, upload, native picker and modal recovery.
const { app, BrowserWindow, dialog, shell } = require('electron')
const { EventEmitter } = require('node:events')
const cp = require('node:child_process')
const assert = require('node:assert/strict')
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zenith-bios-test-'))
const retroarch = path.join(root, 'emulators', 'retroarch'),
  games = path.join(root, 'games'),
  bios = path.join(retroarch, 'system', 'pcsx2', 'bios')
fs.mkdirSync(games, { recursive: true })
fs.mkdirSync(path.join(retroarch, 'cores'), { recursive: true })
for (const file of ['retroarch.exe', 'cores/pcsx2_libretro.dll', 'cores/ppsspp_libretro.dll'])
  fs.writeFileSync(path.join(retroarch, file), coreBinary(file))
for (const file of ['PS2 Demo.iso', 'PSP Demo.iso']) fs.writeFileSync(path.join(games, file), '')
app.getAppPath = () => root
app.setPath('userData', path.join(root, 'profile'))
app.disableHardwareAcceleration()
for (const action of ['show', 'hide', 'restore', 'focus'])
  BrowserWindow.prototype[action] = () => {}
let selection = { canceled: true, filePaths: [] },
  options,
  folderError = '',
  lastFolder,
  spawns = 0
const select = (file) => (selection = { canceled: false, filePaths: [file] })
dialog.showOpenDialog = async (...args) => {
  options = args.at(-1)
  return selection
}
dialog.showMessageBox = async () => ({ response: 0 })
shell.openPath = async (folder) => {
  lastFolder = folder
  return folderError
}
cp.spawn = () => {
  spawns++
  const c = new EventEmitter()
  c.stdout = new EventEmitter()
  c.stderr = new EventEmitter()
  setTimeout(() => {
    c.emit('spawn')
    c.emit('exit', 0)
    c.emit('close', 0)
  }, 30)
  return c
}
globalThis.fetch = async () => new Response('', { status: 404 })
async function run(window) {
  const ev = (s) => window.webContents.executeJavaScript(s)
  const wait = async (s) => {
    for (let i = 0; i < 250; i++) {
      if (await ev(s)) return
      await new Promise((r) => setTimeout(r, 20))
    }
    throw Error('Timed out: ' + s)
  }
  const call = (name, ...args) =>
    ev(`window.electronAPI.${name}(${args.map((a) => JSON.stringify(a)).join(',')})`)
  const click = (s) => ev(`document.querySelector(${JSON.stringify(s)}).click();undefined`)
  await wait("document.querySelectorAll('[data-game-card]').length===2")
  let result = await call('launchGame', path.join(games, 'PS2 Demo.iso'), 'PS2')
  assert.equal(result.error, 'missing_bios')
  assert.equal(result.platform, 'PS2')
  assert.equal(result.ready, false)
  assert.equal(spawns, 0)
  assert.equal((await call('launchGame', path.join(games, 'PSP Demo.iso'), 'PSP')).success, true)
  assert.deepEqual(await call('uploadBios', 'PS2'), { success: false, canceled: true })
  assert.deepEqual(options.filters, [{ name: 'BIOS Files', extensions: ['bin', 'rom'] }])
  assert.deepEqual(await call('openBiosFolder', 'PS2'), { success: true })
  assert.equal(lastFolder, bios)
  folderError = 'Explorer fixture error'
  assert.match((await call('openBiosFolder', 'PS2')).error, /Explorer fixture/)
  folderError = ''
  await click('[data-game-card][aria-label="PS2 Demo"]')
  await click('[data-launch-game]')
  await wait("!!document.querySelector('[data-console-modal=bios][open]')")
  assert.equal(
    await ev("document.querySelector('#console-modal-title').textContent"),
    'Required BIOS file missing'
  )
  const invalid = path.join(root, 'invalid.txt')
  fs.writeFileSync(invalid, 'invalid')
  select(invalid)
  await click('[data-upload-bios]')
  await wait("document.querySelector('dialog [role=alert]')?.textContent.includes('.bin or .rom')")
  const source = path.join(root, 'Synthetic.BIN'),
    bytes = Buffer.alloc(4 * 1024 * 1024)
  fs.writeFileSync(source, bytes)
  select(source)
  const copy = fs.copyFileSync
  try {
    fs.copyFileSync = () => {
      throw Error('copy failure fixture')
    }
    await click('[data-upload-bios]')
    await wait(
      "document.querySelector('dialog [role=alert]')?.textContent.includes('copy failure fixture')"
    )
  } finally {
    fs.copyFileSync = copy
  }
  await click('[data-upload-bios]')
  await wait("document.querySelector('dialog [role=status]')?.textContent==='Ready'")
  assert.deepEqual(fs.readFileSync(path.join(bios, 'Synthetic.BIN')), bytes)
  await ev(
    "Array.from(document.querySelectorAll('dialog button')).find(b=>b.textContent==='Launch game').click();undefined"
  )
  await wait(
    "!document.querySelector('dialog') && !document.querySelector('[data-launch-game]').disabled"
  )
  assert.equal(spawns, 2)
  select(path.join(bios, 'Synthetic.BIN'))
  result = await call('uploadBios', 'PS2')
  assert(result.success && result.status.ready)
  select(source)
  assert.match((await call('uploadBios', 'PS2')).error, /not overwritten/)
  const rom = path.join(root, 'Second.ROM')
  fs.writeFileSync(rom, bytes)
  select(rom)
  result = await call('uploadBios', 'PS2')
  assert.equal(result.fileName, 'Second.bin')
  const ps1 = path.join(root, 'scph5501.bin')
  fs.writeFileSync(ps1, Buffer.alloc(512 * 1024))
  select(ps1)
  result = await call('uploadBios', 'PS1')
  assert(result.status.ready)
  assert(fs.existsSync(path.join(retroarch, 'system', 'scph5501.bin')))
  for (const system of ['../outside', '__proto__', 'PSP', null]) {
    assert.equal((await call('uploadBios', system)).success, false)
    assert.equal((await call('openBiosFolder', system)).success, false)
  }
  select(path.join(root, 'absent.bin'))
  assert.equal((await call('uploadBios', 'PS2')).success, false)
  const status = await call('getSystemStatus')
  assert(status.find((s) => s.platform === 'PS2').bios.ready)
  assert.deepEqual(status.map((s) => s.platform).sort(), ['PS2', 'PSP'])
  await ev(
    "document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'ContextMenu',bubbles:true}));undefined"
  )
  await wait("!!document.querySelector('[data-system-page]')")
  await click('[data-system-page]')
  await wait("!!document.querySelector('[data-delete-bios=PS2]')")
  await click('[data-delete-bios=PS2]')
  await wait("!!document.querySelector('[data-confirm-delete-bios]')")
  await click('[data-confirm-delete-bios]')
  await wait(
    "!!document.querySelector('[data-console-modal=systems]') && !document.querySelector('[data-delete-bios=PS2]')"
  )
  assert(!fs.existsSync(path.join(bios, 'Synthetic.BIN')))
  assert(!fs.existsSync(path.join(bios, 'Second.bin')))
  assert(fs.existsSync(path.join(retroarch, 'system', 'scph5501.bin')))
  assert.equal(
    (await call('launchGame', path.join(games, 'PS2 Demo.iso'), 'PS2')).error,
    'missing_bios'
  )
  assert.equal((await call('deleteBios', '../outside')).success, false)
  console.log(
    'PASS: PS2 diagnosis/PSP exception, PS1 status, upload/cancel/errors, filename normalization, overwrite protection, Explorer, modal readiness and retry'
  )
}
const timer = setTimeout(() => {
  console.error('BIOS test timeout')
  app.exit(1)
}, 30000)
app.once('browser-window-created', (_event, window) =>
  window.webContents.once('did-finish-load', async () => {
    try {
      await run(window)
      clearTimeout(timer)
      app.exit(0)
    } catch (error) {
      console.error(error)
      clearTimeout(timer)
      app.exit(1)
    }
  })
)
require('../out/main/index.js')
