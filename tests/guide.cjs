// Real Electron IPC, modal focus and gamepad input; all network data is synthetic.
const { app, BrowserWindow, nativeImage, net } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zenith-guide-ui-'))
const profile = path.join(root, 'profile')
fs.mkdirSync(path.join(root, 'games'))
for (const title of ['Call of Duty 3 (USA).iso', 'Empty Game.iso'])
  fs.writeFileSync(path.join(root, 'games', title), '')
app.getAppPath = () => root
app.setPath('userData', profile)
app.disableHardwareAcceleration()
BrowserWindow.prototype.show = () => {}
const jpeg = nativeImage
  .createFromBitmap(Buffer.from([205, 190, 150, 255]), { width: 1, height: 1 })
  .resize({ width: 500, height: 650 })
  .toJPEG(85)
const requests = []
let offline = false
let releasePage
const pageGate = new Promise((resolve) => {
  releasePage = resolve
})
globalThis.fetch = async (url) => {
  requests.push(url)
  if (offline) throw Error('offline fixture')
  const parsed = new URL(url)
  if (parsed.hostname === 'en.wikipedia.org') {
    if (!decodeURIComponent(parsed.pathname).includes('Call_of_Duty_3'))
      return new Response('', { status: 404 })
    return Response.json({
      type: 'standard',
      title: 'Call of Duty 3',
      description: '2006 video game',
      extract:
        'Call of Duty 3 is a 2006 first-person shooter game developed by Treyarch and published by Activision. ' +
        'This is a long test introduction for reading with a controller. '.repeat(60),
      titles: { canonical: 'Call_of_Duty_3' }
    })
  }
  if (parsed.pathname === '/advancedsearch.php') {
    const query = parsed.searchParams.get('q')
    return Response.json({
      response: {
        docs:
          query.includes('manuals') && query.includes('Call of Duty 3')
            ? [{ identifier: 'ps2_cod3_manual', title: 'Call of Duty 3 (USA)' }]
            : []
      }
    })
  }
  if (parsed.pathname === '/metadata/ps2_cod3_manual')
    return Response.json({ files: [{ name: 'cod3_scandata.xml' }] })
  if (parsed.pathname.endsWith('_scandata.xml'))
    return new Response(
      '<book><page leafNum="0"></page><page leafNum="1"></page><page leafNum="2"></page></book>'
    )
  if (parsed.pathname.includes('/page/n')) {
    if (parsed.pathname.endsWith('n1.jpg')) await pageGate
    return new Response(jpeg)
  }
  return new Response('', { status: 404 })
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function run(window) {
  const evaluate = (code) => window.webContents.executeJavaScript(code)
  const waitFor = async (code) => {
    for (let i = 0; i < 180; i++) {
      if (await evaluate(code)) return
      await delay(20)
    }
    throw Error(`Timed out: ${code}`)
  }
  const key = (value) =>
    evaluate(
      `document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(value)},bubbles:true,cancelable:true})); undefined`
    )
  const press = async (index, duration = 90) => {
    const before = await evaluate('window.padReads')
    await evaluate(`window.pad.buttons[${index}].pressed=true`)
    await waitFor(`window.padReads > ${before}`)
    await delay(duration)
    const after = await evaluate('window.padReads')
    await evaluate(`window.pad.buttons[${index}].pressed=false`)
    await waitFor(`window.padReads > ${after}`)
  }
  await waitFor(
    "document.querySelectorAll('[data-game-card]').length===2 && !document.querySelector('[data-refresh-library]').disabled"
  )
  assert.equal(
    requests.some((url) => url.includes('wikipedia')),
    false,
    'Guides load only when opened'
  )
  assert.deepEqual(await evaluate('window.electronAPI.getGuideFeatures()'), {
    manualsEnabled: true,
    loreEnabled: true
  })
  assert.equal(await evaluate("window.electronAPI.getManualPage('../outside',0)"), null)
  await evaluate("document.querySelector('input').focus()")
  await key('h')
  assert.equal(
    await evaluate("Boolean(document.querySelector('[data-guide-drawer][open]'))"),
    false,
    'Typing H in search does not open guides'
  )
  await evaluate("document.querySelector('[data-game-card]').focus()")
  await key('H')
  await waitFor("Boolean(document.querySelector('[data-guide-drawer][open]'))")
  await waitFor("document.querySelector('[data-guide-drawer]').textContent.includes('Treyarch')")
  assert(
    await evaluate("document.querySelector('[data-guide-drawer]').textContent.includes('2006')")
  )
  await key('Tab')
  assert(
    await evaluate("document.querySelector('[data-guide-drawer]').contains(document.activeElement)")
  )
  await evaluate("document.querySelector('[data-guide-tab=manual]').click()")
  await waitFor("document.querySelector('[data-manual-image]')?.naturalWidth>0")
  assert.equal(
    await evaluate("document.querySelector('[data-guide-page-count]').textContent"),
    'Page 1 / 3'
  )
  const games = await evaluate('window.electronAPI.getLocalGames()')
  const url = await evaluate(
    `window.electronAPI.getManualPage(${JSON.stringify(games[0].gameId)},0)`
  )
  assert(url.startsWith('game-media://local/'))
  assert.deepEqual(Buffer.from(await (await net.fetch(url)).arrayBuffer()), jpeg)
  await key('ArrowRight')
  await waitFor("document.querySelector('[data-guide-page-count]').textContent==='Page 2 / 3'")
  await key('ArrowRight')
  await waitFor("document.querySelector('[data-manual-image]')?.alt.endsWith('Page 3')")
  releasePage()
  await delay(120)
  assert(
    await evaluate("document.querySelector('[data-manual-image]').alt.endsWith('Page 3')"),
    'Late page 2 never replaces page 3'
  )
  await key('ArrowRight')
  assert.equal(
    await evaluate("document.querySelector('[data-guide-page-count]').textContent"),
    'Page 3 / 3'
  )
  assert.equal(
    await evaluate("document.querySelector('h1').textContent"),
    'Call of Duty 3',
    'Page navigation never changes the selected game'
  )
  await key('Escape')
  await waitFor("!document.querySelector('[data-guide-drawer]')")
  assert(
    await evaluate("document.activeElement.matches('[data-game-card]')"),
    'Focus returns to selected card'
  )

  await evaluate(
    "window.pad={connected:true,axes:[0,0,0,0],buttons:Array.from({length:16},()=>({pressed:false}))}; window.padReads=0; Object.defineProperty(navigator,'getGamepads',{value:()=>{window.padReads++;return [window.pad]}}); undefined"
  )
  await press(3, 450)
  await waitFor("!!document.querySelector('[data-console-modal=options][open]')")
  await evaluate("document.querySelector('[data-open-guide]').click()")
  await waitFor("Boolean(document.querySelector('[data-guide-drawer][open]'))")
  for (const value of ['ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown']) {
    await key(value)
    assert.equal(
      await evaluate(
        "document.querySelector('[data-guide-tab=lore]').getAttribute('aria-selected')"
      ),
      'true',
      'Keyboard navigation never switches tabs'
    )
  }
  for (const button of [14, 15]) {
    await press(button)
    assert.equal(
      await evaluate(
        "document.querySelector('[data-guide-tab=lore]').getAttribute('aria-selected')"
      ),
      'true',
      'D-pad horizontal never switches tabs'
    )
  }
  await evaluate('window.pad.axes[0]=1')
  await delay(1200)
  await evaluate('window.pad.axes[0]=0')
  assert.equal(
    await evaluate("document.querySelector('[data-guide-tab=lore]').getAttribute('aria-selected')"),
    'true',
    'Left stick never switches tabs'
  )
  await evaluate("document.querySelector('#guide-panel-lore').scrollTo({top:0,behavior:'instant'})")
  await press(13)
  await waitFor("document.querySelector('#guide-panel-lore').scrollTop>0")
  await evaluate('window.pad.axes[3]=-1')
  await waitFor("document.querySelector('#guide-panel-lore').scrollTop===0")
  await evaluate('window.pad.axes[3]=0')
  await press(5, 450)
  await waitFor(
    "document.querySelector('[data-guide-tab=manual]').getAttribute('aria-selected')==='true'"
  )
  assert.equal(
    await evaluate("document.querySelector('[data-guide-page-count]').textContent"),
    'Page 1 / 3',
    'Held RB switches tab once without turning a page'
  )
  await press(5)
  assert.equal(
    await evaluate(
      "document.querySelector('[data-guide-tab=manual]').getAttribute('aria-selected')"
    ),
    'true',
    'RB stays at the final tab'
  )
  await press(15)
  assert.equal(
    await evaluate("document.querySelector('[data-guide-prev]').textContent.trim()"),
    '←'
  )
  assert.equal(
    await evaluate("document.querySelector('[data-guide-next]').textContent.trim()"),
    '→'
  )
  assert.equal(
    await evaluate("document.querySelector('[data-guide-page-count]').textContent"),
    'Page 2 / 3',
    'D-pad right turns a manual page'
  )
  assert.equal(
    await evaluate("document.querySelector('[aria-controls=console-filters]').textContent.trim()"),
    'All consolesView'
  )
  await press(14)
  assert.equal(
    await evaluate("document.querySelector('[data-guide-page-count]').textContent"),
    'Page 1 / 3'
  )
  await press(4)
  await waitFor(
    "document.querySelector('[data-guide-tab=lore]').getAttribute('aria-selected')==='true'"
  )
  await press(1)
  await waitFor("!document.querySelector('[data-guide-drawer]')")
  await key('h')
  await waitFor("Boolean(document.querySelector('[data-guide-drawer][open]'))")
  await press(3)
  await waitFor("!document.querySelector('[data-guide-drawer]')")

  offline = true
  const before = requests.length
  await key('h')
  await waitFor("document.querySelector('[data-guide-drawer]')?.textContent.includes('Treyarch')")
  await evaluate("document.querySelector('[data-guide-tab=manual]').click()")
  await waitFor("document.querySelector('[data-manual-image]')?.naturalWidth>0")
  assert.equal(requests.length, before, 'Cached lore and manual pages work offline')
  await key('h')
  await waitFor("!document.querySelector('[data-guide-drawer]')")
  await key('ArrowRight')
  await waitFor("document.querySelector('h1').textContent==='Empty Game'")
  await key('h')
  await waitFor(
    "document.querySelector('[data-guide-drawer]')?.textContent.includes('No story information was found for this game.')"
  )
  await evaluate("document.querySelector('[data-guide-tab=manual]').click()")
  await waitFor(
    "document.querySelector('[data-manual-empty]')?.textContent.includes('Original manual not found')"
  )
  await key('Escape')
  console.log(
    'PASS: H/Y toggle, B/Escape, lore/manual IPC, focus, LB/RB tabs, D-pad pages and scroll, right-stick scroll, stale-page cleanup, local images, offline cache and empty states'
  )
}
const timeout = setTimeout(() => {
  console.error('Guide UI timeout')
  app.exit(1)
}, 45000)
app.once('browser-window-created', (_event, window) => {
  window.webContents.setBackgroundThrottling(false)
  window.webContents.once('did-finish-load', async () => {
    try {
      await run(window)
      clearTimeout(timeout)
      app.exit(0)
    } catch (error) {
      console.error(error)
      console.log(
        await window.webContents.executeJavaScript(
          "JSON.stringify({reads:window.padReads,hidden:document.hidden,drawer:document.querySelector('[data-guide-drawer]')?.open,active:document.activeElement.outerHTML.slice(0,150)})"
        )
      )
      clearTimeout(timeout)
      app.exit(1)
    }
  })
})
require('../out/main/index.js')
