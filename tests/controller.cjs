// Real renderer and native dialogs, with an isolated library and simulated standard gamepad.
const { app, BrowserWindow, dialog } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zenith-controller-'))
fs.mkdirSync(path.join(root, 'games'))
for (const name of [
  'Alpha.iso',
  'Beta.iso',
  'Delta.iso',
  'Echo.iso',
  'Foxtrot.iso',
  'Gamma.iso',
  'Hotel.iso',
  'India.iso',
  'Juliet.iso'
])
  fs.writeFileSync(path.join(root, 'games', name), '')
app.getAppPath = () => root
app.setPath('userData', path.join(root, 'profile'))
app.disableHardwareAcceleration()
BrowserWindow.prototype.show = () => {}
globalThis.fetch = async () => new Response('', { status: 404 })
let launchDialogs = 0
dialog.showMessageBox = async () => {
  launchDialogs++
  return { response: 0 }
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function run(window) {
  const evaluate = (code) => window.webContents.executeJavaScript(code)
  const waitFor = async (code) => {
    for (let i = 0; i < 200; i++) {
      if (await evaluate(code)) return
      await delay(25)
    }
    throw Error(`Timed out: ${code}`)
  }
  const key = (value) =>
    evaluate(
      `document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key:${JSON.stringify(value)},bubbles:true,cancelable:true})); undefined`
    )
  const press = async (index, duration = 70) => {
    const before = await evaluate('window.padReads')
    await evaluate(`window.pad.buttons[${index}].pressed=true`)
    await waitFor(`window.padReads>${before}`)
    await delay(duration)
    const after = await evaluate('window.padReads')
    await evaluate(`window.pad.buttons[${index}].pressed=false`)
    await waitFor(`window.padReads>${after}`)
  }
  const input = (selector, value) =>
    evaluate(`{
    const input=document.querySelector(${JSON.stringify(selector)});
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});
    input.dispatchEvent(new Event('input',{bubbles:true}));
  }`)
  await waitFor("document.querySelectorAll('[data-game-card]').length===9")
  assert.equal(await evaluate("document.body.textContent.includes('DOLBY AUDIO')"), false)
  assert.equal(await evaluate("!!document.querySelector('[data-controller-status]')"), false)
  assert(await evaluate("!!document.querySelector('[data-library-footer] [data-game-options]')"))
  assert.match(
    await evaluate("document.querySelector('[data-system-clock]').textContent"),
    /^\d{2}:\d{2}$/
  )
  await evaluate(
    `window.RealDate=Date; window.clockText='09:17'; window.Date=class extends window.RealDate { toLocaleTimeString() { return window.clockText } }; undefined`
  )
  await waitFor("document.querySelector('[data-system-clock]').textContent==='09:17'")
  await evaluate("window.clockText='09:18'")
  await waitFor("document.querySelector('[data-system-clock]').textContent==='09:18'")
  await evaluate('window.Date=window.RealDate; undefined')

  await evaluate(
    `window.pad={id:'Xbox test',index:1,connected:true,battery:{level:0.75},axes:[0,0,0,0],buttons:Array.from({length:17},()=>({pressed:false}))}; window.padReads=0; Object.defineProperty(navigator,'getGamepads',{value:()=>{window.padReads++;return [null,window.pad]}}); undefined`
  )
  await waitFor("document.querySelector('[data-controller-battery]')?.textContent==='75%'")
  await evaluate('window.pad.battery.level=0')
  await waitFor("document.querySelector('[data-controller-battery]')?.textContent==='0%'")
  await evaluate('delete window.pad.battery')
  await waitFor(
    "!!document.querySelector('[data-controller-status]') && !document.querySelector('[data-controller-battery]')"
  )
  // Drift does not switch the input mode or move the library.
  await evaluate('window.pad.axes[0]=0.12')
  await delay(1200)
  assert.equal(
    await evaluate("document.querySelector('[data-library-footer] kbd').textContent"),
    'Enter'
  )
  await evaluate('window.pad.axes[0]=0')
  await press(15)
  await waitFor("document.querySelector('h1').textContent==='Beta'")
  assert.equal(
    await evaluate("document.querySelector('[data-library-footer] kbd').textContent"),
    'A'
  )
  await key('Shift')
  await waitFor("document.querySelector('[data-library-footer] kbd').textContent==='Enter'")
  await press(14)
  await waitFor("document.querySelector('h1').textContent==='Alpha'")

  const stick = async (x, y) => {
    const before = await evaluate('window.padReads')
    await evaluate('window.pad.axes[0]=' + x + '; window.pad.axes[1]=' + y)
    await waitFor('window.padReads>' + before)
    const after = await evaluate('window.padReads')
    await evaluate('window.pad.axes[0]=0; window.pad.axes[1]=0')
    await waitFor('window.padReads>' + after)
  }
  const selected = (title) =>
    waitFor("document.querySelector('h1').textContent===" + JSON.stringify(title))
  const closed = () => waitFor("!document.querySelector('[data-osk]')")
  const focusCard = (title) =>
    waitFor(
      "document.activeElement.matches('[data-game-card]') && document.activeElement.getAttribute('aria-label')===" +
        JSON.stringify(title)
    )
  await press(3)
  await waitFor("!!document.querySelector('[data-console-modal=options][open]')")
  assert(await evaluate("document.activeElement.hasAttribute('data-open-guide')"))
  assert.equal(await evaluate("document.querySelectorAll('[data-modal-content] button').length"), 2)
  await press(13)
  assert.equal(await evaluate('document.activeElement.textContent.trim()'), 'Delete game')
  await evaluate(
    "document.activeElement.blur();window.dispatchEvent(new Event('blur'));window.dispatchEvent(new Event('focus'));undefined"
  )
  await waitFor(
    "document.activeElement.matches('[data-game-option]') && document.querySelector('[data-console-modal=options]').dataset.focusedOptionIndex==='1'"
  )
  assert.equal(await evaluate('document.activeElement.textContent.trim()'), 'Delete game')
  await stick(0, -1)
  assert(await evaluate("document.activeElement.hasAttribute('data-open-guide')"))
  await press(1)
  await waitFor("!document.querySelector('dialog[open]')")
  await focusCard('Alpha')
  await press(12, 450)
  await selected('Alpha')
  await focusCard('Alpha')
  assert.equal(
    await evaluate("!!document.querySelector('[data-osk]')"),
    false,
    'D-pad up at the top row never opens search'
  )
  await stick(0, -1)
  await selected('Alpha')
  assert.equal(
    await evaluate("!!document.querySelector('[data-osk]')"),
    false,
    'Analog up stays at the top boundary'
  )
  for (const navigation of [
    [
      [15, 'Beta'],
      [13, 'Juliet'],
      [12, 'Alpha'],
      [14, 'Alpha']
    ],
    [
      [[1, 0], 'Beta'],
      [[0, 1], 'Juliet'],
      [[0, -1], 'Alpha'],
      [[-1, 0], 'Alpha']
    ]
  ]) {
    for (const [command, title] of navigation) {
      if (Array.isArray(command)) await stick(...command)
      else await press(command)
      await selected(title)
      await focusCard(title)
    }
  }
  await press(15)
  await selected('Beta')
  await press(3)
  await waitFor(
    "document.activeElement.hasAttribute('data-open-guide') && document.querySelector('[data-console-modal=options]').dataset.focusedOptionIndex==='0'"
  )
  await press(13)
  await evaluate('document.activeElement.blur();undefined')
  await press(0)
  await waitFor("!!document.querySelector('[data-console-modal=delete][open]')")
  await press(1)
  await waitFor("!document.querySelector('dialog[open]')")
  await focusCard('Beta')
  await press(3)
  await waitFor(
    "document.activeElement.hasAttribute('data-open-guide') && document.querySelector('[data-console-modal=options]').dataset.focusedOptionIndex==='0'"
  )
  await press(1)
  await focusCard('Beta')
  assert.equal(
    await evaluate("document.querySelector('[data-search-trigger] kbd').textContent"),
    'X'
  )
  // Clicking while gamepad was last used must still focus only a native input.
  await evaluate(
    "const input=document.querySelector('[data-search-input]'); input.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true})); input.focus(); input.click(); undefined"
  )
  await closed()
  await key('/')
  await closed()
  await key('Escape')
  await focusCard('Beta')
  await key('/')
  assert(await evaluate("document.activeElement.matches('[data-search-input]')"))
  await closed()
  await key('Escape')
  await focusCard('Beta')

  await press(2, 450)
  await waitFor("!!document.querySelector('[data-osk][open]')")
  assert(await evaluate("document.querySelector('[data-osk]').contains(document.activeElement)"))
  const consoleBefore = await evaluate(
    "document.querySelector('[aria-controls=console-filters]').textContent"
  )
  await press(5)
  assert.equal(
    await evaluate("document.querySelector('[aria-controls=console-filters]').textContent"),
    consoleBefore,
    'OSK consumes console shortcuts'
  )
  await press(0, 450)
  await waitFor("document.querySelector('[data-osk] input').value==='Q'")
  await press(15)
  await press(0)
  await waitFor("document.querySelector('[data-osk] input').value==='QW'")
  await stick(0, 1)
  assert.equal(await evaluate('document.activeElement.dataset.oskKey'), '1-1')
  await press(2)
  await waitFor("document.querySelector('[data-osk] input').value==='Q'")
  await selected('Beta')
  assert.equal(
    await evaluate("document.querySelectorAll('[data-game-card]').length"),
    9,
    'OSK draft never changes the background selection or library'
  )
  await evaluate("document.querySelector('[data-game-card]').focus()")
  assert(
    await evaluate("document.querySelector('[data-osk]').contains(document.activeElement)"),
    'Native modal traps focus'
  )
  await input('[data-osk] input', 'AB')
  const action = async (name) =>
    evaluate(`document.querySelector('[data-osk-action="${name}"]').click();undefined`)
  await action('left')
  await action('Q')
  await waitFor("document.querySelector('[data-osk] input').value==='AQB'")
  await action('erase')
  await action('right')
  await action('space')
  await waitFor("document.querySelector('[data-osk] input').value==='AB '")
  await action('mode')
  await action('1')
  await action('?')
  await waitFor("document.querySelector('[data-osk] input').value==='AB 1?'")
  assert(
    await evaluate(
      "!!document.querySelector('[data-osk-action=erase] svg') && !!document.querySelector('[data-osk-action=done] svg')"
    )
  )
  await action('clear')
  await action('mode')
  const letterRows = () =>
    evaluate(
      "Array.from(document.querySelectorAll('.osk-row')).slice(0,3).map(row=>Array.from(row.querySelectorAll('[data-osk-action]')).map(el=>el.dataset.oskAction).join(' '))"
    )
  assert.deepEqual(await letterRows(), [
    'Q W E R T Y U I O P',
    'A S D F G H J K L',
    'Z X C V B N M erase'
  ])
  await action('language')
  assert.deepEqual(await letterRows(), [
    'Q W E R T Y U I O P Ğ Ü',
    'A S D F G H J K L Ş İ',
    'Z X C V B N M Ö Ç erase'
  ])
  await action('İ')
  await action('Ğ')
  await waitFor("document.querySelector('[data-osk] input').value==='İĞ'")
  await action('language')
  await action('clear')
  await waitFor("document.querySelector('[data-osk] input').value===''")
  await press(9)
  await closed()
  await focusCard('Beta')
  await press(15)
  await focusCard('Delta')
  await press(2)
  await waitFor("!!document.querySelector('[data-osk][open]')")
  await press(1, 450)
  await closed()
  await focusCard('Delta')
  await press(14)
  await focusCard('Beta')
  // With a changed query, restore the old card if present, otherwise the first result.
  await press(2)
  await waitFor("!!document.querySelector('[data-osk][open]')")
  await input('[data-osk] input', 'Alpha')
  await selected('Beta')
  await key('Shift')
  assert.equal(await evaluate("document.querySelector('[data-osk] kbd').textContent"), 'Esc')
  await key('Escape')
  await closed()
  await focusCard('Alpha')
  assert.equal(await evaluate("document.querySelectorAll('[data-game-card]').length"), 1)
  await press(2)
  await waitFor("!!document.querySelector('[data-osk][open]')")
  await input('[data-osk] input', 'no matches')
  await press(1)
  await closed()
  assert(
    await evaluate("document.activeElement.matches('[data-search-input]')"),
    'Empty results keep a usable fallback focus'
  )
  await press(2)
  await waitFor("!!document.querySelector('[data-osk][open]')")
  await input('[data-osk] input', '')
  await press(1)
  await closed()
  await focusCard('Alpha')
  await key('/')
  await input('[data-search-input]', 'Beta')
  await selected('Beta')
  await closed()
  await key('Escape')
  await focusCard('Beta')
  await evaluate('window.pad.connected=false')
  await waitFor("!document.querySelector('[data-controller-status]')")
  assert.equal(launchDialogs, 0, 'Typing and closing OSK never launches a game')
  assert.equal(await evaluate("!!document.querySelector('[data-bios-modal]')"), false)
  console.log(
    'PASS: live clock, controller connect/battery/drift/disconnect, last-input badges, grid focus, four-direction D-pad/analog parity, top boundary, explicit search, OSK focus restore/trap, draft isolation and native search'
  )
}
const timeout = setTimeout(() => {
  console.error('Controller UI timeout')
  app.exit(1)
}, 100000)
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
          "JSON.stringify({focus:document.activeElement.outerHTML.slice(0,200),osk:!!document.querySelector('[data-osk][open]'),reads:window.padReads})"
        )
      )
      clearTimeout(timeout)
      app.exit(1)
    }
  })
})
require('../out/main/index.js')
