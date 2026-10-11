// Real renderer and native dialogs, with an isolated library and simulated standard gamepad.
const { app, BrowserWindow, dialog } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const { discImage } = require('./fixtures/disc-image.cjs')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zenith-controller-'))
fs.mkdirSync(path.join(root, 'games'))
const fixtureNames = [
  'Alpha.iso',
  'Beta.iso',
  'Delta.iso',
  'Echo.iso',
  'Foxtrot.iso',
  'Gamma.iso',
  'Hotel.iso',
  'India.iso',
  'Juliet.iso',
  // Keep multiple grid rows available on wide fullscreen monitors.
  ...Array.from({ length: 64 }, (_, i) => `Z-fixture-${String(i).padStart(2, '0')}.iso`)
]
for (const name of fixtureNames) fs.writeFileSync(path.join(root, 'games', name), discImage('PS2'))
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
  await waitFor(`document.querySelectorAll('[data-game-card]').length===${fixtureNames.length}`)
  const { titles } = await evaluate(`(() => {
    const cards = Array.from(document.querySelectorAll('[data-game-card]'));
    return {
      titles: cards.map(card => card.getAttribute('aria-label'))
    };
  })()`)
  assert(titles.length > 2, 'Fixture provides horizontal navigation targets')
  const focusSounds = await evaluate(`(() => {
    const original=HTMLMediaElement.prototype.play;
    let sounds=0;
    HTMLMediaElement.prototype.play=function(){if(this.src.includes('.wav')){sounds++;return Promise.resolve()}return original.call(this)};
    const cards=[...document.querySelectorAll('[data-game-card]')];
    cards[0].focus();sounds=0;
    for(let i=0;i<12;i++){
      const card=cards[i%2===0?1:0];
      let delivered=false;
      const observed=()=>{delivered=true};card.addEventListener('focusin',observed);
      card.focus();
      // Hidden test windows can update activeElement without delivering native focus events.
      if(!delivered)card.dispatchEvent(new FocusEvent('focusin',{bubbles:true}));
      card.removeEventListener('focusin',observed);
    }
    HTMLMediaElement.prototype.play=original;
    return sounds;
  })()`)
  assert.equal(
    focusSounds,
    12,
    'Every card focus event starts audio, even within one renderer turn'
  )
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
  await press(2)
  await waitFor("!!document.querySelector('[data-console-modal=options][open]')")
  assert(await evaluate("document.activeElement.hasAttribute('data-open-guide')"))
  assert(await evaluate("document.querySelectorAll('[data-modal-content] button').length >= 2"))
  await press(13)
  assert.equal(
    await evaluate("document.activeElement.querySelector('strong').textContent.trim()"),
    'Search for media again'
  )
  await evaluate(
    "document.activeElement.blur();window.dispatchEvent(new Event('blur'));window.dispatchEvent(new Event('focus'));undefined"
  )
  await waitFor(
    "document.activeElement.matches('[data-game-option]') && document.querySelector('[data-console-modal=options]').dataset.focusedOptionIndex==='1'"
  )
  assert.equal(
    await evaluate("document.activeElement.querySelector('strong').textContent.trim()"),
    'Search for media again'
  )
  await stick(0, -1)
  assert(await evaluate("document.activeElement.hasAttribute('data-open-guide')"))
  await press(1)
  await waitFor("!document.querySelector('dialog[open]')")
  await focusCard('Alpha')
  await press(12, 450)
  await selected('Alpha')
  assert(
    await evaluate("document.activeElement.matches('[data-action-dock] [data-console-filter]')")
  )
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
    'Analog up on the dock never opens the OSK'
  )
  await press(15)
  assert(await evaluate("document.activeElement.matches('[data-search-input]')"))
  await stick(1, 0)
  assert(await evaluate("document.activeElement.matches('[data-add-game]')"))
  await press(15)
  assert(await evaluate("document.activeElement.matches('[data-refresh-library]')"))
  await waitFor(
    "document.activeElement.dataset.dockFocused==='true' && getComputedStyle(document.activeElement).boxShadow!=='none'"
  )
  await press(14)
  await stick(-1, 0)
  assert(await evaluate("document.activeElement.matches('[data-search-input]')"))
  await press(0)
  await waitFor("!!document.querySelector('[data-osk][open]')")
  await press(1)
  await closed()
  await focusCard('Alpha')
  const columns = Number(await evaluate("document.querySelector('[data-columns]').dataset.columns"))
  const nextRow = fixtureNames[columns + 1].replace('.iso', '')
  for (const navigation of [
    [
      [15, 'Beta'],
      [13, nextRow],
      [12, 'Beta'],
      [14, 'Alpha']
    ],
    [
      [[1, 0], 'Beta'],
      [[0, 1], nextRow],
      [[0, -1], 'Beta'],
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
  await press(2)
  await waitFor(
    "document.activeElement.hasAttribute('data-open-guide') && document.querySelector('[data-console-modal=options]').dataset.focusedOptionIndex==='0'"
  )
  await press(13)
  await press(13)
  await press(13)
  await evaluate('document.activeElement.blur();undefined')
  await press(0)
  await waitFor("!!document.querySelector('[data-console-modal=delete][open]')")
  await press(1)
  await waitFor("!document.querySelector('dialog[open]')")
  await focusCard('Beta')
  await press(2)
  await waitFor(
    "document.activeElement.hasAttribute('data-open-guide') && document.querySelector('[data-console-modal=options]').dataset.focusedOptionIndex==='0'"
  )
  await press(1)
  await focusCard('Beta')
  assert.equal(
    await evaluate("document.querySelector('[data-search-trigger] kbd').textContent"),
    'Y'
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

  await press(3, 450)
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
    fixtureNames.length,
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
  // Multiple movement events before React paints must not collapse into a single step;
  // A in that same frame must activate the new position, not the previous render's key.
  const burst = await evaluate(`(() => {
    const dialog=document.querySelector('[data-osk]');
    const first=dialog.querySelector('[data-osk-key="0-0"]');
    first.focus();first.dispatchEvent(new FocusEvent('focusin',{bubbles:true}));
    const send=(move,button=-1)=>dialog.dispatchEvent(new CustomEvent('controller-input',{
      detail:{move,hit:index=>index===button}
    }));
    for(let i=0;i<6;i++)send('right');
    send(null,0);
    return document.activeElement.dataset.oskKey;
  })()`)
  assert.equal(burst, '0-6', 'No gamepad movement is dropped within a render frame')
  await waitFor("document.querySelector('[data-osk] input').value==='U'")
  await evaluate(`{
    for(let i=0;i<16;i++)document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{
      key:'ArrowLeft',bubbles:true,cancelable:true
    }));
  }`)
  await waitFor("document.querySelector('.osk-selected')?.dataset.oskKey==='0-0'")
  assert.equal(await evaluate("document.querySelectorAll('.osk-selected').length"), 1)
  assert.equal(
    await evaluate('document.querySelectorAll(\'[data-osk-key][tabindex="0"]\').length'),
    1
  )
  assert.equal(await evaluate('document.activeElement.dataset.oskKey'), '0-0')
  await key('ArrowLeft')
  assert.equal(await evaluate('document.activeElement.dataset.oskKey'), '0-9')
  await key('ArrowRight')
  assert.equal(await evaluate('document.activeElement.dataset.oskKey'), '0-0')
  await press(3)
  await waitFor("document.querySelector('[data-osk] input').value==='U '")
  await press(2)
  await waitFor("document.querySelector('[data-osk] input').value==='U'")

  // Real Chromium layout at desktop and handheld sizes: ratios/gaps/row heights must
  // remain stable across EN, TR and symbols, including the widest twelve-key rows.
  for (const [width, height] of [
    [1920, 1080],
    [1280, 800],
    [800, 600]
  ]) {
    window.webContents.enableDeviceEmulation({
      screenPosition: 'desktop',
      screenSize: { width, height },
      viewSize: { width, height },
      deviceScaleFactor: 1,
      scale: 1
    })
    for (const layout of ['en', 'tr', 'symbols']) {
      if (layout === 'tr') await action('language')
      if (layout === 'symbols') await action('mode')
      await delay(160)
      const geometry = await evaluate(`(() => {
        const dialog=document.querySelector('[data-osk]');
        const letters=[...dialog.querySelectorAll('.osk-row:not(.osk-functions) .osk-key')];
        const tools=[...dialog.querySelectorAll('.osk-functions .osk-key')];
        const box=dialog.getBoundingClientRect();
        return {
          ratios:letters.map(el=>el.offsetWidth/el.offsetHeight),
          heights:[...letters,...tools].map(el=>el.offsetHeight),
          gaps:[...dialog.querySelectorAll('.osk-row')].map(el=>parseFloat(getComputedStyle(el).gap)),
          overflow:dialog.scrollWidth>dialog.clientWidth,
          clipped:[...letters,...tools].some(el=>{
            const key=el.getBoundingClientRect();
            return key.left<box.left||key.right>box.right||key.bottom>box.bottom||key.top<box.top;
          }),
          space:dialog.querySelector('[data-osk-action=space]').offsetWidth,
          mode:dialog.querySelector('[data-osk-action=mode]').offsetWidth
        };
      })()`)
      const dock = await evaluate(`(() => {
        const dock=document.querySelector('[data-action-dock]');
        const items=[...dock.querySelectorAll(':scope > button,:scope > .dock-search')];
        const rect=dock.getBoundingClientRect();
        const badges=[...dock.querySelectorAll('kbd')];
        return {heights:items.map(el=>el.offsetHeight),fits:items.every(el=>{const b=el.getBoundingClientRect();return b.left>=rect.left&&b.right<=rect.right}),badgeColors:badges.map(el=>getComputedStyle(el).backgroundColor)};
      })()`)
      assert(
        dock.heights.every((h) => h === 40),
        `${width}: dock segments share 40px height`
      )
      assert(dock.fits, `${width}: dock segments stay inside the glass surface`)
      assert.equal(
        new Set(dock.badgeColors).size,
        2,
        'Search Y uses the shared amber console badge'
      )
      assert(
        await evaluate(
          "(()=>{const a=getComputedStyle(document.querySelector('[data-search-trigger] .pad-Y')),b=getComputedStyle(document.querySelector('[data-library-footer] .pad-Y'));return ['width','height','color','backgroundColor','borderRadius','borderColor','fontSize','fontWeight'].every(k=>a[k]===b[k])})()"
        )
      )
      const badgeStyles =
        await evaluate(`Array.from(document.querySelectorAll('[data-gamepad-badge]')).map(el=>{
        const css=getComputedStyle(el);return {button:el.dataset.gamepadBadge,color:css.color,background:css.backgroundColor,border:css.borderColor,width:css.width,height:css.height}
      })`)
      const palette = {
        A: ['rgb(2, 6, 23)', 'rgb(52, 211, 153)', 'rgb(2, 6, 23)'],
        B: ['rgb(2, 6, 23)', 'rgb(244, 63, 94)', 'rgb(2, 6, 23)'],
        X: ['rgb(2, 6, 23)', 'rgb(56, 189, 248)', 'rgb(2, 6, 23)'],
        Y: ['rgb(2, 6, 23)', 'rgb(251, 191, 36)', 'rgb(2, 6, 23)']
      }
      for (const button of Object.keys(palette))
        assert(
          badgeStyles.some((b) => b.button === button),
          `Rendered ${button} badge`
        )
      for (const badge of badgeStyles) {
        if (palette[badge.button]) {
          assert.deepEqual(
            [badge.color, badge.background, badge.border],
            palette[badge.button],
            badge.button + ' shared Xbox palette'
          )
          assert.equal(badge.width, '20px')
          assert.equal(badge.height, '20px')
        } else assert.equal(badge.background, 'rgba(255, 255, 255, 0.2)')
      }
      assert(
        geometry.ratios.every((r) => r >= 1.05 && r <= 1.15),
        `${layout} ${width}: near-square letters`
      )
      assert.equal(
        new Set(geometry.heights).size,
        1,
        `${layout} ${width}: all keys have equal height`
      )
      assert(
        geometry.gaps.every((g) => g >= 6 && g <= 8),
        `${layout} ${width}: 6–8px gaps`
      )
      assert.equal(geometry.overflow, false, `${layout} ${width}: no horizontal overflow`)
      assert.equal(
        geometry.clipped,
        false,
        `${layout} ${width}: keys and focus scale fit the dialog`
      )
      assert(geometry.space > geometry.mode * 2, `${layout} ${width}: balanced flexible space bar`)
      if (width === 1280 && layout === 'tr' && process.argv.includes('--screenshot')) {
        await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })
        await delay(250)
        fs.writeFileSync(
          path.resolve('osk-preview.png'),
          (
            await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })
          ).toPNG()
        )
      }
    }
    await action('mode')
    await action('language')
  }
  window.webContents.disableDeviceEmulation()
  await action('clear')
  await press(7)
  await closed()
  await focusCard('Beta')
  await press(15)
  await focusCard('Delta')
  await press(3)
  await waitFor("!!document.querySelector('[data-osk][open]')")
  await press(1, 450)
  await closed()
  await focusCard('Delta')
  await press(14)
  await focusCard('Beta')
  // With a changed query, restore the old card if present, otherwise the first result.
  await press(3)
  await waitFor("!!document.querySelector('[data-osk][open]')")
  await input('[data-osk] input', 'Alpha')
  await selected('Beta')
  await key('Shift')
  assert.equal(await evaluate("document.querySelector('[data-osk] kbd').textContent"), 'Esc')
  await key('Escape')
  await closed()
  await focusCard('Alpha')
  assert.equal(await evaluate("document.querySelectorAll('[data-game-card]').length"), 1)
  await press(3)
  await waitFor("!!document.querySelector('[data-osk][open]')")
  await input('[data-osk] input', 'no matches')
  await press(1)
  await closed()
  assert(
    await evaluate("document.activeElement.matches('[data-search-input]')"),
    'Empty results keep a usable fallback focus'
  )
  await press(3)
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
  // Active search shows only a compact X clear action; clearing cannot open Game Options.
  await press(13)
  assert.equal(
    await evaluate(
      "document.querySelector('[data-action-dock] [data-clear-search] kbd').textContent"
    ),
    'X'
  )
  assert.equal(
    await evaluate(
      "document.querySelector('[data-action-dock] [data-clear-search] span').textContent"
    ),
    'Clear'
  )
  assert.equal(
    await evaluate("!!document.querySelector('[data-action-dock] [data-search-trigger]')"),
    false
  )
  if (process.argv.includes('--screenshot')) {
    await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })
    await delay(250)
    fs.writeFileSync(
      path.resolve('dock-search-preview.png'),
      (
        await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })
      ).toPNG()
    )
  }
  await press(2)
  await waitFor(`document.querySelectorAll('[data-game-card]').length===${fixtureNames.length}`)
  assert.equal(await evaluate("!!document.querySelector('dialog[open]')"), false)
  for (const resetKey of ['x', 'Backspace']) {
    await key('/')
    await input('[data-search-input]', 'Beta')
    await selected('Beta')
    await key('ArrowDown')
    await key(resetKey)
    await waitFor(`document.querySelectorAll('[data-game-card]').length===${fixtureNames.length}`)
  }
  await evaluate('window.pad.connected=false')
  await waitFor("!document.querySelector('[data-controller-status]')")
  assert.equal(launchDialogs, 0, 'Typing and closing OSK never launches a game')
  assert.equal(await evaluate("!!document.querySelector('[data-bios-modal]')"), false)
  console.log(
    'PASS: live clock, controller connect/battery/drift/disconnect, last-input badges, grid focus, four-direction D-pad/analog parity, top boundary, explicit search, OSK focus restore/trap, rapid same-frame navigation/activation, EN/TR/symbol geometry at desktop/handheld sizes, draft isolation and native search'
  )
}
const timeout = setTimeout(() => {
  console.error('Controller UI timeout')
  app.exit(1)
}, 130000)
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
