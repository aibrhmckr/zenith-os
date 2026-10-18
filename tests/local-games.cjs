// Runs the built app in a hidden Electron window with an isolated ROM directory.
const { app, BrowserWindow, nativeImage } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const pspPath = process.argv.includes('--psp-path')
const fixtureRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), pspPath ? 'zenith-pSp-games-test-' : 'zenith-games-test-')
)
const gamesDirectory = path.join(fixtureRoot, 'games')
app.getAppPath = () => fixtureRoot
app.setPath('userData', path.join(fixtureRoot, 'profile'))
app.disableHardwareAcceleration()
// Hidden Chromium windows may suspend compositor animations. Exercise the app's
// reduced-motion scroll path so geometry assertions do not depend on visibility.
app.commandLine.appendSwitch('force-prefers-reduced-motion')
BrowserWindow.prototype.show = () => {}

const expectedSystems = {
  iso: pspPath ? 'PSP' : 'PS3',
  pkg: 'PS3',
  chd: 'PS2',
  gz: 'PS2',
  cue: 'PS1',
  pbp: 'PS1',
  cso: 'PSP',
  nds: 'NDS',
  gba: 'GBA',
  gb: 'GBC',
  gbc: 'GBC',
  gcm: 'GameCube',
  rvz: 'GameCube',
  wbfs: 'Wii',
  z64: 'N64',
  n64: 'N64',
  sfc: 'SNES',
  smc: 'SNES',
  nes: 'NES',
  '3ds': '3DS',
  cia: '3DS',
  md: 'Genesis',
  gen: 'Genesis',
  cdi: 'Dreamcast',
  gdi: 'Dreamcast',
  smd: 'Genesis',
  v64: 'N64',
  a26: 'Atari 2600',
  a78: 'Atari 7800',
  lnx: 'Atari Lynx',
  bin: 'Unassigned',
  rom: 'Unassigned',
  atx: 'Unassigned',
  zip: 'Unassigned',
  '7z': 'Unassigned'
}

async function checkWindow(window) {
  const evaluate = (code) => window.webContents.executeJavaScript(code)
  const waitFor = async (code) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate(code)) return
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
    const layout = await evaluate(`(() => {
      const card = document.querySelector('[data-game-card][aria-pressed=true]');
      const grid = card?.parentElement;
      return grid ? {section:document.querySelector('.dashboard-library').dataset, tracks:getComputedStyle(grid).gridTemplateColumns, scrollTop:grid.scrollTop, scrollHeight:grid.scrollHeight, clientHeight:grid.clientHeight,
        card:card.getBoundingClientRect().toJSON(), grid:grid.getBoundingClientRect().toJSON()} : null;
    })()`)
    throw new Error(`Timed out: ${code}; layout=${JSON.stringify(layout)}`)
  }
  const reload = async () => {
    const loaded = new Promise((resolve) => window.webContents.once('did-finish-load', resolve))
    window.reload()
    await loaded
  }
  const selected = () =>
    evaluate(
      "document.querySelector('[data-game-card][aria-pressed=true]')?.getAttribute('aria-label')"
    )
  const key = (value, selector = 'body') =>
    evaluate(
      `document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(value)}, bubbles: true, cancelable: true }))`
    )

  await waitFor(
    "document.body.textContent.includes('Add a game or place your ROM files in the games folder.')"
  )
  assert(fs.statSync(gamesDirectory).isDirectory(), 'Missing games folder is created')
  assert.deepEqual(await evaluate('window.electronAPI.getLocalGames()'), [])
  for (const extension of Object.keys(expectedSystems)) {
    fs.writeFileSync(
      path.join(gamesDirectory, `Game-${extension}.${extension.toUpperCase()}`),
      'fixture'
    )
  }
  fs.mkdirSync(path.join(gamesDirectory, 'not-a-game.iso'))
  fs.writeFileSync(path.join(gamesDirectory, 'ignored.txt'), '')
  fs.writeFileSync(path.join(gamesDirectory, 'Özel # % oyun.iso'), '')
  const hints = {
    'Example (PS3).iso': 'PS3',
    'Example PlayStation 3.ISO': 'PS3',
    'Portable (PSP).iso': 'PSP',
    'Portable pSp.ISO': 'PSP',
    'Grand Theft Auto - Vice City Stories (USA).iso': 'PSP',
    'vice city stories.iso': 'PSP',
    'PSP name should not override.chd': 'PS2'
  }
  for (const name of Object.keys(hints)) fs.writeFileSync(path.join(gamesDirectory, name), '')
  const image = nativeImage.createFromBitmap(Buffer.from([120, 80, 40, 255]), {
    width: 1,
    height: 1
  })
  assert(!image.isEmpty(), 'Cover fixture must be a valid image')
  fs.writeFileSync(path.join(gamesDirectory, 'Game-iso.JPG'), image.toJPEG(90))
  fs.writeFileSync(path.join(gamesDirectory, 'Game-iso.png'), image.toPNG())
  fs.writeFileSync(path.join(gamesDirectory, 'Game-nds.PNG'), image.toPNG())
  fs.writeFileSync(path.join(gamesDirectory, 'Özel # % oyun.png'), image.toPNG())

  const games = await evaluate('window.electronAPI.getLocalGames()')
  const ps3 = games.find((game) => game.fileName === 'Game-pkg.PKG')
  assert(ps3)
  const ps3Launch = await evaluate(
    `window.electronAPI.launchGame(${JSON.stringify(ps3.path)}, 'PS3')`
  )
  assert.equal(ps3Launch.success, false)
  assert.equal(ps3Launch.error, 'ps3_package_not_installed')
  assert.equal(games.length, Object.keys(expectedSystems).length + 1 + Object.keys(hints).length)
  for (const [name, system] of Object.entries(hints)) {
    assert.equal(games.find((game) => game.fileName === name).systemShort, system)
  }
  assert.equal(
    games.find((game) => game.fileName === 'Özel # % oyun.iso').systemShort,
    pspPath ? 'PSP' : 'PS3'
  )
  for (const [extension, system] of Object.entries(expectedSystems)) {
    const game = games.find(
      (item) => item.fileName === `Game-${extension}.${extension.toUpperCase()}`
    )
    assert.equal(game.systemShort, system)
    assert.equal(game.title, `Game-${extension}`)
    assert.equal(game.path, path.join(gamesDirectory, game.fileName))
    assert.equal(game.cover, game.backdrop)
    if (!['iso', 'nds'].includes(extension)) {
      assert.equal(game.cover, null)
      assert.equal(game.coverUrl, null)
    }
  }
  assert.equal(
    games.find((game) => game.title === 'Game-iso').cover,
    path.join(gamesDirectory, 'Game-iso.JPG')
  )
  assert.equal(
    games.find((game) => game.title === 'Game-nds').cover,
    path.join(gamesDirectory, 'Game-nds.PNG')
  )
  assert.equal(new Set(games.map((game) => game.id)).size, games.length)
  await reload()
  await waitFor(`document.querySelectorAll('[data-game-card]').length === ${games.length}`)
  // Fullscreen uses the monitor width; validate responsive capacity rather than
  // assuming the old 1440px window always contains eight columns.
  const { columns, availableWidth } = await evaluate(`(() => {
    const grid = document.querySelector('[data-game-card]').parentElement;
    const style = getComputedStyle(grid);
    return {
      columns: style.gridTemplateColumns.split(' ').length,
      availableWidth: grid.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
    };
  })()`)
  assert.equal(columns, Math.max(1, Math.floor((availableWidth + 16) / (144 + 16))))
  const titles = games.map((game) => game.title)
  assert.equal(await selected(), titles[0])
  await key('ArrowRight')
  await waitFor(`document.querySelector('h1').textContent === ${JSON.stringify(titles[1])}`)
  await key('ArrowDown')
  await waitFor(
    `document.querySelector('h1').textContent === ${JSON.stringify(titles[1 + columns])}`
  )
  await key('ArrowUp')
  await waitFor(`document.querySelector('h1').textContent === ${JSON.stringify(titles[1])}`)
  await key('ArrowLeft')
  await waitFor(`document.querySelector('h1').textContent === ${JSON.stringify(titles[0])}`)
  await key('ArrowLeft')
  await waitFor(`document.querySelector('h1').textContent === ${JSON.stringify(titles[0])}`)
  for (let i = 0; i < games.length - 1; i++) {
    await key('ArrowRight')
    await waitFor(`document.querySelector('h1').textContent === ${JSON.stringify(titles[i + 1])}`)
  }
  // A wide/fullscreen display may fit the whole fixture without scrolling.
  // Require a visible selected card in both cases, and scrolling only for overflow.
  await waitFor(`(() => {
    const card = document.querySelector('[data-game-card][aria-pressed=true]');
    const grid = card.parentElement;
    const bounds = grid.getBoundingClientRect(), selected = card.getBoundingClientRect();
    return selected.top >= bounds.top - 1 && selected.bottom <= bounds.bottom + 1 &&
      (grid.scrollHeight <= grid.clientHeight + 1 || grid.scrollTop > 0);
  })()`)
  await key('ArrowDown')
  assert.equal(await selected(), titles.at(-1), 'Last incomplete row stays in bounds')
  await evaluate("document.querySelector('input').focus()")
  await key('ArrowLeft', 'input')
  assert.equal(await selected(), titles.at(-1), 'Search cursor does not move game selection')

  for (const game of games.filter((item) => item.coverUrl)) {
    const loaded = await evaluate(
      `new Promise(resolve => { const img = new Image(); img.onload = () => resolve(img.naturalWidth > 0); img.onerror = () => resolve(false); img.src = ${JSON.stringify(game.coverUrl)} })`
    )
    assert(loaded, `Local cover loads: ${game.coverUrl}`)
  }

  await evaluate("document.querySelector('[aria-controls=console-filters]').click()")
  await waitFor(
    `document.querySelectorAll('#console-filters button').length === ${new Set(Object.values(expectedSystems)).size + 1}`
  )
  assert.deepEqual(
    (
      await evaluate(
        "Array.from(document.querySelectorAll('#console-filters button'), b => b.dataset.consoleFilter)"
      )
    ).sort(),
    ['ALL', ...new Set(Object.values(expectedSystems))].sort()
  )
  await evaluate("document.querySelector('#console-filters [data-console-filter=NDS]').click()")
  await waitFor("document.querySelectorAll('[data-game-card]').length === 1")
  assert.equal(await selected(), 'Game-nds')
  await evaluate(
    `const input = document.querySelector('input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'no matching game'); input.dispatchEvent(new Event('input', { bubbles: true }))`
  )
  await waitFor("document.body.textContent.includes('No matching games.')")
  assert.equal(await evaluate("document.querySelectorAll('[data-game-card]').length"), 0)

  await reload()
  await waitFor(`document.querySelectorAll('[data-game-card]').length === ${games.length}`)
  await evaluate(
    `window.testPad = { connected: true, axes: [0, 0], buttons: Array.from({ length: 16 }, () => ({ pressed: false })) }; Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => [null, window.testPad] }); window.testPad.buttons[15].pressed = true`
  )
  await waitFor(`document.querySelector('h1').textContent === ${JSON.stringify(titles[1])}`)
  await evaluate('window.testPad.buttons[15].pressed = false')
  await new Promise((resolve) => setTimeout(resolve, 50))
  await evaluate('window.testPad.buttons[5].pressed = true')
  await waitFor(
    "document.querySelector('[aria-controls=console-filters] > span').textContent.trim() === 'PS2'"
  )
  await new Promise((resolve) => setTimeout(resolve, 450))
  assert.equal(
    await evaluate(
      "document.querySelector('[aria-controls=console-filters] > span').textContent.trim()"
    ),
    'PS2',
    'Held bumper switches only once even when result count changes'
  )
  await evaluate(
    'window.testPad.buttons[5].pressed = false; window.testPad.buttons[2].pressed = true'
  )
  await waitFor("Boolean(document.querySelector('[data-console-modal=options][open]'))")
  await evaluate('window.testPad.buttons[2].pressed = false')

  fs.renameSync(gamesDirectory, path.join(fixtureRoot, 'saved-games'))
  fs.writeFileSync(gamesDirectory, 'not a directory')
  await reload()
  await waitFor(
    "document.body.textContent.includes('The library or cache could not be read. Check folder permissions.')"
  )
  console.log(
    'PASS: folder creation, all ROM extensions, covers, IPC, responsive fullscreen grid, keyboard, filters, simulated gamepad, empty and error states'
  )
}

const timeout = setTimeout(() => {
  console.error('Electron test timed out')
  app.exit(1)
}, 30000)
app.once('browser-window-created', (_event, window) => {
  // show() is stubbed: allow transitions/scroll animations in this hidden test window.
  window.webContents.setBackgroundThrottling(false)
  window.webContents.once('did-finish-load', async () => {
    try {
      await checkWindow(window)
      clearTimeout(timeout)
      app.exit(0)
    } catch (error) {
      console.error(error)
      clearTimeout(timeout)
      app.exit(1)
    }
  })
})
// Do not contact the CDN for synthetic ROM fixtures.
globalThis.fetch = async () => new Response('', { status: 503 })
require('../out/main/index.js')
