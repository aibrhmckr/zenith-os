import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import {
  assertAllowedPath,
  externalBrowserUrl,
  secureIpcHandle,
  hardenWebContents
} from '../src/main/services/securityBoundary.js'
import { createFileBrowser } from '../src/main/services/fileBrowser.js'
import {
  validateIsoMembers,
  inspectIsoExtraction
} from '../src/main/services/isoExtractionPolicy.js'

test('all IPC handlers reject foreign windows, subframes and navigated dashboard documents before side effects', () => {
  let handler,
    calls = 0
  const contents = { isDestroyed: () => false, mainFrame: { url: 'file:///app/index.html' } }
  secureIpcHandle(
    {
      handle: (_channel, fn) => {
        handler = fn
      }
    },
    () => contents,
    () => 'file:///app/index.html'
  )('delete-game', () => ++calls)
  for (const event of [
    {},
    { sender: contents, senderFrame: { url: 'file:///app/index.html' } },
    { sender: {}, senderFrame: contents.mainFrame }
  ])
    assert.throws(() => handler(event), /Unauthorized/)
  contents.mainFrame.url = 'https://attacker.invalid/'
  assert.throws(
    () => handler({ sender: contents, senderFrame: contents.mainFrame }),
    /Unauthorized/
  )
  assert.equal(calls, 0)
  contents.mainFrame.url = 'file:///app/index.html#settings'
  assert.equal(handler({ sender: contents, senderFrame: contents.mainFrame }), 1)
})

test('external navigation is HTTP(S)-only; popups, navigations, webviews and permissions are denied', async () => {
  for (const url of [
    'file:///C:/secret',
    'javascript:alert(1)',
    'ms-settings:foo',
    'https://user:pass@example.com',
    'invalid'
  ])
    assert.equal(externalBrowserUrl(url), null)
  const contents = new EventEmitter(),
    opened = []
  let open, permission, check
  contents.setWindowOpenHandler = (fn) => {
    open = fn
  }
  contents.session = {
    setPermissionRequestHandler: (fn) => {
      permission = fn
    },
    setPermissionCheckHandler: (fn) => {
      check = fn
    }
  }
  hardenWebContents(contents, (url) => opened.push(url))
  assert.deepEqual(open({ url: 'https://example.com' }), { action: 'deny' })
  open({ url: 'file:///C:/secret' })
  await Promise.resolve()
  assert.deepEqual(opened, ['https://example.com/'])
  for (const event of [
    'will-navigate',
    'will-frame-navigate',
    'will-redirect',
    'will-attach-webview'
  ]) {
    let prevented = false
    contents.emit(event, {
      preventDefault: () => {
        prevented = true
      }
    })
    assert(prevented)
  }
  permission(null, 'media', (value) => assert.equal(value, false))
  assert.equal(check(), false)
})

test('filesystem scope rejects traversal, sibling-prefix attacks and junction escapes; tickets are revalidated', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zenith-security-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const safe = path.join(root, 'games'),
    outside = path.join(root, 'games-private')
  await fs.mkdir(safe)
  await fs.mkdir(outside)
  await fs.writeFile(path.join(outside, 'private.png'), 'private')
  const browser = createFileBrowser({ roots: [safe] })
  await assert.rejects(browser.list({ kind: 'wallpaper', path: outside }), /approved/)
  assert.throws(() => assertAllowedPath(safe + '/../../private', [safe]), /Invalid/)
  await fs.symlink(
    outside,
    path.join(safe, 'escape'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  await assert.rejects(
    browser.list({ kind: 'wallpaper', path: path.join(safe, 'escape') }),
    /approved/
  )
  const folder = path.join(safe, 'folder')
  await fs.mkdir(folder)
  await fs.writeFile(path.join(folder, 'game.iso'), 'disc')
  const listing = await browser.list({ kind: 'games', path: folder })
  await fs.rename(folder, path.join(safe, 'original'))
  await fs.symlink(outside, folder, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(browser.consume('games', [listing.entries[0].token]), /approved/)
})

test('ISO extraction rejects oversized targets before writes and forces non-compressed formats', async () => {
  assert.throws(() => validateIsoMembers('Path = PS3_GAME/ICON0.PNG\nSize = 9999999999'), /Unsafe/)
  assert.throws(() => validateIsoMembers('Path = ../../ICON0.PNG\nSize = 100'), /Unsafe/)
  const calls = []
  await assert.rejects(
    inspectIsoExtraction('7z', 'malicious.iso', async (_exe, args) => {
      calls.push(args)
      return { stdout: 'Path = ICON0.PNG\nSize = 9999999999' }
    }),
    /safe extraction/
  )
  assert.equal(calls.length, 2)
  assert(
    calls.every((args) => args[0] === 'l' && (args.includes('-tudf') || args.includes('-tiso')))
  )
})
