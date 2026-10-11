// Real Electron renderer/preload with synthetic ROMs and a stubbed update action.
const { app, BrowserWindow, ipcMain } = require('electron')
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path')
const assert = require('node:assert/strict')
const { discImage } = require('./fixtures/disc-image.cjs')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zenith-navigation-cards-'))
fs.mkdirSync(path.join(root, 'games'), { recursive: true })
for (const name of [
  'First (PS3).iso',
  'Second (PS3).iso',
  'Classic (PS2).iso',
  'Portable.cso',
  'Dual.nds',
  'Arcade.a26'
]) {
  fs.writeFileSync(
    path.join(root, 'games', name),
    name.endsWith('.iso') ? discImage(name.includes('PS3') ? 'PS3' : 'PS2') : 'synthetic'
  )
}
app.getAppPath = () => root
app.setPath('userData', path.join(root, 'profile'))
app.disableHardwareAcceleration()
BrowserWindow.prototype.show = () => {}
globalThis.fetch = async () => new Response('', { status: 404 })
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const timer = setTimeout(() => {
  console.error('Navigation card UI timeout')
  app.exit(1)
}, 45000)
let updates = 0
app.once('browser-window-created', (_, win) => {
  win.webContents.setBackgroundThrottling(false)
  const spotlightLogs = []
  win.webContents.on('console-message', (event) => {
    if (event.message.startsWith('[GameSpotlight Data]:')) spotlightLogs.push(event.message)
  })
  win.webContents.once('did-finish-load', async () => {
    const ev = (code) => win.webContents.executeJavaScript(code)
    const wait = async (code) => {
      for (let i = 0; i < 250; i++) {
        if (await ev(code)) return
        await delay(20)
      }
      throw Error('Timeout: ' + code)
    }
    const click = (sel) => ev(`document.querySelector(${JSON.stringify(sel)}).click();undefined`)
    const focus = (sel) =>
      ev(
        `(()=>{const el=document.querySelector(${JSON.stringify(sel)});el.focus();el.dispatchEvent(new FocusEvent('focusin',{bubbles:true}))})()`
      )
    const key = (key) =>
      ev(
        `document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},bubbles:true,cancelable:true}));undefined`
      )
    const pad = async (move, button = -1) => {
      await ev(
        `document.querySelector('dialog[open]').dispatchEvent(new CustomEvent('controller-input',{detail:{move:${JSON.stringify(move)},hit:i=>i===${button},axes:[0,0,0,0],now:performance.now()}}));undefined`
      )
      await delay(40)
    }
    const screenshot = async (name) => {
      if (!process.argv.includes('--screenshot')) return
      await ev(
        'document.getAnimations().filter(a=>a.effect.getTiming().iterations!==Infinity).forEach(a=>a.finish());undefined'
      )
      // Hidden test windows may retain an older compositor frame until capture wakes them.
      await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })
      await delay(250)
      fs.writeFileSync(
        path.resolve(name),
        (
          await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })
        ).toPNG()
      )
    }
    try {
      ipcMain.removeHandler('software:update')
      ipcMain.handle('software:update', () => {
        updates++
        return { success: true }
      })
      await wait("document.querySelectorAll('[data-game-card]').length===6")
      await wait("!document.querySelector('[data-refresh-library]').disabled")
      const library = await ev('window.electronAPI.getLocalGames()')
      const selected = await ev(
        "document.querySelector('[data-game-card][aria-pressed=true]').dataset.gameId"
      )
      const game = library.find((item) => item.id === selected)
      assert(await ev("!!document.querySelector('[data-game-card] .poster-fallback svg')"))
      const art =
        'data:image/svg+xml,' +
        encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="200"><rect width="500" height="200" fill="#164e63"/><text x="20" y="100" fill="white">ZENITH TEST</text></svg>'
        )
      win.webContents.send('game-media-updated', {
        ...game,
        logoUrl: art,
        coverUrl: art,
        year: 2007,
        genre: 'Adventure',
        developer: 'Example Studio',
        publisher: 'Example Publisher',
        metadata: { year: null },
        summary: 'A quiet journey into an uncharted world.'
      })
      await wait(
        "!!document.querySelector('.spotlight-logo') && document.querySelector('.spotlight-chips').textContent.includes('2007')"
      )
      assert(
        (await ev("document.querySelector('.spotlight-synopsis').textContent")).includes(
          'quiet journey'
        )
      )
      assert.equal(
        await ev("document.querySelectorAll('[data-spotlight-host] [data-game-spotlight]').length"),
        1,
        'Spotlight is mounted on the dashboard'
      )
      assert.equal(
        await ev("document.querySelector('[data-spotlight-chip=publisher]').textContent"),
        'Example Publisher'
      )
      assert(await ev("!!document.querySelector('.spotlight-platform svg')"))
      assert.equal(
        await ev(
          "getComputedStyle(document.querySelector('[data-spotlight-vignette]')).pointerEvents"
        ),
        'none'
      )
      assert.equal(
        await ev("getComputedStyle(document.querySelector('.spotlight-logo')).maxHeight"),
        '80px'
      )
      const safeSpotlight = async (selector) => {
        const box = await ev(`(()=>{
          const el=document.querySelector(${JSON.stringify(selector)}),r=el.getBoundingClientRect();
          const shade=document.querySelector('[data-spotlight-vignette]'),s=shade.getBoundingClientRect();
          return {left:r.left,right:r.right,width:innerWidth,padding:parseFloat(getComputedStyle(document.querySelector('[data-spotlight-host]')).paddingLeft),shadeLeft:s.left,shadeWidth:s.width,shadeHeight:s.height,height:innerHeight,gradient:getComputedStyle(shade).backgroundImage};
        })()`)
        assert.equal(box.padding, box.width >= 768 ? 64 : 48)
        assert(
          box.left >= box.padding && box.right <= box.width - box.padding + 1,
          'Spotlight stays inside safe edges'
        )
        assert.equal(box.shadeLeft, 0)
        assert(Math.abs(box.shadeWidth - box.width * (2 / 3)) < 1)
        assert.equal(box.shadeHeight, box.height)
        assert(box.gradient.includes('linear-gradient'))
      }
      await safeSpotlight('.spotlight-logo')
      assert(
        await ev(`(()=>{
        const vignette=document.querySelector('[data-spotlight-vignette]');
        const layers=[...document.querySelectorAll('.wallpaper-background,.hero-fixed-image')];
        return getComputedStyle(vignette).zIndex==='0' && layers.every(el=>!!(el.compareDocumentPosition(vignette)&Node.DOCUMENT_POSITION_FOLLOWING)) && getComputedStyle(document.querySelector('[data-game-spotlight]')).zIndex==='10';
      })()`),
        'Vignette follows artwork at z=0; Spotlight text stays at z=10'
      )
      assert.equal(
        await ev(
          "getComputedStyle(document.querySelector('[data-game-card][aria-pressed=true] img')).objectFit"
        ),
        'cover'
      )
      assert.equal(
        await ev(
          "getComputedStyle(document.querySelector('[data-game-card][aria-pressed=true] img')).objectPosition"
        ),
        '50% 0%'
      )
      assert(
        await ev(
          "!!document.querySelector('[data-system-dock] [data-downloads-trigger]') && !!document.querySelector('[data-system-dock] [data-settings-trigger]')"
        )
      )
      const posterGap = await ev(
        "(()=>{const b=document.querySelector('[data-game-card]').getBoundingClientRect(),footer=document.querySelector('[data-library-footer]').getBoundingClientRect();return footer.top-b.bottom})()"
      )
      assert(posterGap >= 20, 'Card caption and glow have footer clearance')
      await screenshot('spotlight-preview.png')
      for (const alias of ['clearLogo', 'logoPath']) {
        win.webContents.send('game-media-updated', {
          ...game,
          logoUrl: null,
          clearLogo: null,
          logoPath: null,
          [alias]: art,
          year: null,
          releaseYear: null,
          releaseDate: '2009-07-01',
          genres: ['Action', 'Adventure'],
          synopsis: null,
          description: null,
          overview: 'An overview supplied by a different provider.',
          metadata: {}
        })
        await wait("document.querySelector('[data-spotlight-chip=year]')?.textContent==='2009'")
        await wait(
          "document.querySelector('.spotlight-logo')?.complete && document.querySelector('.spotlight-logo')?.naturalWidth>0"
        )
        assert.equal(
          await ev("document.querySelector('.spotlight-logo').getAttribute('src')"),
          art,
          alias + ' renders'
        )
        assert.equal(
          await ev("document.querySelector('[data-spotlight-chip=genre]').textContent"),
          'Action, Adventure'
        )
        assert(
          (await ev("document.querySelector('.spotlight-synopsis').textContent")).includes(
            'different provider'
          )
        )
      }
      await ev(
        "document.querySelector('.spotlight-logo').dispatchEvent(new Event('error'));undefined"
      )
      await wait("!!document.querySelector('[data-game-spotlight] h1')")
      assert.equal(
        await ev("getComputedStyle(document.querySelector('[data-game-spotlight] h1')).fontWeight"),
        '900'
      )
      assert(spotlightLogs.length > 0, 'Spotlight data is visible in the renderer console')
      assert.equal(
        await ev("document.querySelector('[data-game-spotlight] h1').textContent"),
        game.title
      )
      win.webContents.send('game-media-updated', {
        ...game,
        logoUrl: null,
        title: 'Ice Age 3 — Dawn of the Dinosaurs ' + 'LongUnbrokenGameTitle'.repeat(8)
      })
      await wait(
        "document.querySelector('[data-game-spotlight] h1')?.textContent.startsWith('Ice Age 3')"
      )
      for (const width of [1920, 1280, 800, 640]) {
        win.webContents.enableDeviceEmulation({
          screenPosition: 'desktop',
          screenSize: { width, height: 1080 },
          viewSize: { width, height: 1080 },
          deviceScaleFactor: 1,
          scale: 1
        })
        await delay(100)
        // Neither a long title nor focus-driven/programmatic ancestor scrolling may shift the hero.
        await ev(
          "document.querySelector('.zenith-shell').scrollLeft=300;document.documentElement.scrollLeft=300;undefined"
        )
        await safeSpotlight('[data-game-spotlight] h1')
      }
      win.webContents.disableDeviceEmulation()
      await delay(100)
      const other = library.find((item) => item.id !== selected)
      await focus(`[data-game-card][data-game-id="${other.id}"]`)
      await wait(
        `document.querySelector('[data-game-spotlight] h1')?.textContent===${JSON.stringify(other.title)}`
      )
      assert.equal(
        await ev("document.querySelectorAll('[data-spotlight-chip]').length"),
        2,
        'Region and format replace missing rich metadata on the next game'
      )
      assert.equal(
        await ev("getComputedStyle(document.querySelector('[data-game-spotlight]')).animationName"),
        'spotlight-reveal'
      )
      await click('[aria-controls=console-filters]')
      await wait("!!document.querySelector('#console-filters')")
      assert.deepEqual(
        await ev(
          "[...document.querySelectorAll('#console-filters button')].map(b=>[b.dataset.consoleFilter,Number(b.querySelector('[data-game-count]').dataset.gameCount)])"
        ),
        [
          ['ALL', 6],
          ['PS2', 1],
          ['PS3', 2],
          ['PSP', 1],
          ['NDS', 1],
          ['Atari 2600', 1]
        ]
      )
      assert.equal(await ev("document.querySelectorAll('#console-filters svg').length"), 6)
      assert.equal(await ev('document.activeElement.dataset.consoleFilter'), 'ALL')
      await key('ArrowRight')
      assert.equal(await ev('document.activeElement.dataset.consoleFilter'), 'PS2')
      await pad('down')
      assert.equal(await ev('document.activeElement.dataset.consoleFilter'), 'NDS')
      await pad('up')
      await pad('right')
      assert.equal(await ev('document.activeElement.dataset.consoleFilter'), 'PS3')
      assert.notEqual(await ev('getComputedStyle(document.activeElement).boxShadow'), 'none')
      await pad(null, 0)
      await wait(
        "!document.querySelector('dialog[open]') && document.querySelectorAll('[data-game-card]').length===2"
      )
      await click('[aria-controls=console-filters]')
      await wait("!!document.querySelector('#console-filters')")
      assert.equal(
        await ev(
          "document.querySelector('[data-console-filter=PS3]').getAttribute('aria-pressed')"
        ),
        'true'
      )
      assert.equal(
        await ev(
          "document.querySelector('[data-console-filter=ALL] [data-game-count]').dataset.gameCount"
        ),
        '6',
        'Counts remain global after filtering'
      )
      await screenshot('filter-cards-preview.png')
      await pad(null, 1)
      await wait("!document.querySelector('dialog[open]')")
      assert.equal(
        await ev("document.querySelectorAll('[data-game-card]').length"),
        2,
        'Cancel preserves filter'
      )
      await click('[data-settings-trigger]')
      await wait("!!document.querySelector('[role=combobox]')")
      assert.equal(await ev('document.activeElement.getAttribute("role")'), 'combobox')
      assert.equal(await ev("document.querySelectorAll('.settings-navigation-card').length"), 3)
      assert.equal(await ev("document.querySelectorAll('.settings-navigation-card svg').length"), 6)
      assert.equal(updates, 0, 'Opening Settings cannot initiate an update')
      const aligned = await ev(
        "(()=>{const title=document.querySelector('.settings-language-card h3').getBoundingClientRect(),box=document.querySelector('[role=combobox]').getBoundingClientRect();return box.left>title.right && Math.abs(box.y+box.height/2-title.y-title.height/2)<2})()"
      )
      assert(aligned, 'Language caption and dropdown share a row')
      const languageHeight = await ev(
        "document.querySelector('.settings-language-card').offsetHeight"
      )
      const followingY = await ev(
        "document.querySelector('.settings-toggle').getBoundingClientRect().y"
      )
      await pad(null, 0)
      assert.equal(
        await ev("document.querySelector('.settings-language-card').offsetHeight"),
        languageHeight
      )
      assert.equal(
        await ev("document.querySelector('.settings-toggle').getBoundingClientRect().y"),
        followingY
      )
      assert.equal(
        await ev("getComputedStyle(document.querySelector('.console-dropdown-list')).position"),
        'absolute'
      )
      await pad('down')
      await pad(null, 0)
      await wait("document.documentElement.lang==='tr'")
      assert.equal(
        await ev("document.querySelector('.settings-language-card h3').textContent"),
        'Dil Seçimi'
      )
      assert.equal(
        await ev("document.querySelector('[data-wallpaper-page] strong').textContent"),
        'Duvar Kâğıtları'
      )
      await focus('[data-wallpaper-page]')
      await key('ArrowDown')
      assert(await ev('document.activeElement.hasAttribute("data-system-page")'))
      await pad('down')
      assert(await ev('document.activeElement.hasAttribute("data-software-update")'))
      await wait(
        "(()=>{const footer=document.querySelector('[data-legal-notice]').getBoundingClientRect(),modal=document.querySelector('dialog[open]').getBoundingClientRect();return footer.bottom<=modal.bottom && footer.top>=modal.top})()"
      )
      assert.equal(updates, 0, 'Focusing the update card is not activation')
      await pad(null, 0)
      await wait(
        'document.querySelector("[role=status]")?.textContent.includes("Güncelleme başlatıldı")'
      )
      assert.equal(updates, 1)
      win.webContents.send('downloads:progress', [
        {
          id: 'software-update',
          kind: 'softwareUpdate',
          status: 'active',
          developer: true,
          component: 'stella_libretro.dll',
          componentPercent: 90,
          completedComponents: 3,
          totalComponents: 6,
          updatedAt: Date.now()
        }
      ])
      await wait("document.querySelector('[data-update-tracker]')?.textContent.includes('90%')")
      assert(
        (await ev("document.querySelector('[data-update-tracker]').textContent")).includes('3 / 6')
      )
      for (let i = 0; i < 16; i++) await pad('up')
      await wait(
        "(()=>{const item=document.querySelector('[role=combobox]').getBoundingClientRect(),modal=document.querySelector('dialog[open]').getBoundingClientRect();return item.top >= modal.top && item.bottom <= modal.bottom})()"
      )
      assert.equal(
        await ev('document.activeElement.getAttribute("role")'),
        'combobox',
        'Up returns focus and scroll to first control'
      )
      const settingsTopVisible = `(()=>{
        const modal=document.querySelector('[data-console-modal=settings]');
        const box=modal.getBoundingClientRect();
        return modal.scrollTop < 1 &&
          ['header h2','[data-modal-close]','.settings-language-card'].every(selector=>{
            const r=modal.querySelector(selector).getBoundingClientRect();
            return r.top>=box.top+20 && r.bottom<=box.bottom;
          });
      })()`
      await wait(settingsTopVisible)
      assert.equal(
        await ev(
          "getComputedStyle(document.querySelector('[data-console-modal=settings]')).scrollPaddingTop"
        ),
        '48px'
      )
      assert.equal(
        await ev(
          "getComputedStyle(document.querySelector('[data-console-modal=settings]')).paddingTop"
        ),
        '24px'
      )
      // Repeat at handheld height, including repeated Up at the first control.
      win.webContents.enableDeviceEmulation({
        screenPosition: 'desktop',
        screenSize: { width: 1280, height: 720 },
        viewSize: { width: 1280, height: 720 },
        deviceScaleFactor: 1,
        scale: 1
      })
      await delay(100)
      await focus('[data-software-update]')
      await pad('down')
      await wait("document.querySelector('[data-console-modal=settings]').scrollTop > 100")
      for (let i = 0; i < 16; i++) await pad('up')
      await wait(settingsTopVisible)
      assert.equal(await ev('document.activeElement.getAttribute("role")'), 'combobox')
      assert.equal(updates, 1, 'Returning to the top never activates an option')
      win.webContents.disableDeviceEmulation()
      await delay(100)
      await focus('[data-wallpaper-page]')
      await ev(
        "document.querySelector('[data-wallpaper-page]').scrollIntoView({block:'center'});undefined"
      )
      await delay(100)
      await screenshot('settings-cards-preview.png')
      await pad(null, 0)
      await wait("!!document.querySelector('[data-wallpaper-gallery]')")
      await pad(null, 1)
      await wait("!!document.querySelector('[data-console-modal=settings]')")
      await focus('[data-system-page]')
      await pad(null, 0)
      await wait("!!document.querySelector('[data-console-modal=systems]')")
      console.log(
        'PASS: console icons/counts, global totals, selected/focused glow, keyboard/D-pad/A/B, language row/TR dropdown, navigation destinations and explicit update activation'
      )
      clearTimeout(timer)
      app.exit(0)
    } catch (error) {
      console.error(error)
      console.log(await ev('document.body.innerText'))
      clearTimeout(timer)
      app.exit(1)
    }
  })
})
require('../out/main/index.js')
