import fs from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

/** Renderer paths must stay inside Main-owned roots, including after junction resolution. */
export function assertAllowedPath(value, roots) {
  if (
    typeof value !== 'string' ||
    !isAbsolute(value) ||
    [...value].some((character) => character.charCodeAt(0) < 32) ||
    value.split(/[\\/]/).includes('..') ||
    /^\\\\/.test(value) ||
    (process.platform === 'win32' && value.slice(2).includes(':'))
  )
    throw Error('Invalid local path.')
  const inside = (root, target) => {
    const rel = relative(root, target)
    return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep))
  }
  const target = resolve(value)
  for (const root of roots) {
    const base = resolve(root)
    if (!inside(base, target)) continue
    try {
      if (inside(fs.realpathSync(base), fs.realpathSync(target))) return target
    } catch {
      /* Missing/unreadable roots do not grant access. */
    }
  }
  throw Error('Path is outside approved directories.')
}

/** No native protocol handlers, credentials or malformed URLs may cross this boundary. */
export function externalBrowserUrl(value) {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null
  } catch {
    return null
  }
}

/** Only the actual dashboard main frame, at the expected document, can invoke privileged IPC. */
export function isTrustedSender(event, contents, documentUrl) {
  if (
    !contents ||
    contents.isDestroyed() ||
    event.sender !== contents ||
    !event.senderFrame ||
    event.senderFrame !== contents.mainFrame
  )
    return false
  try {
    const actual = new URL(event.senderFrame.url),
      expected = new URL(documentUrl)
    actual.hash = ''
    expected.hash = ''
    return actual.href === expected.href
  } catch {
    return false
  }
}

export function secureIpcHandle(ipcMain, getContents, getDocumentUrl) {
  return (channel, handler) =>
    ipcMain.handle(channel, (event, ...args) => {
      if (!isTrustedSender(event, getContents(), getDocumentUrl()))
        throw Error('Unauthorized IPC sender.')
      return handler(event, ...args)
    })
}

/** Keep navigation and permission decisions in Main; never navigate the privileged dashboard away. */
export function hardenWebContents(contents, openExternal) {
  contents.setWindowOpenHandler(({ url }) => {
    const safe = externalBrowserUrl(url)
    if (safe)
      Promise.resolve()
        .then(() => openExternal(safe))
        .catch(() => {})
    return { action: 'deny' }
  })
  for (const event of [
    'will-navigate',
    'will-frame-navigate',
    'will-redirect',
    'will-attach-webview'
  ])
    contents.on(event, (e) => e.preventDefault())
  contents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false)
  )
  contents.session.setPermissionCheckHandler(() => false)
}
