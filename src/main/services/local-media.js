import fs from 'node:fs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { basename, extname, isAbsolute, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'

/**
 * Runtime-only URL-to-file capabilities registered by Main; never resolve an arbitrary
 * renderer-supplied path.
 */
const allowed = new Map()
/** Short-lived browser preview capability, independent of persistent library URLs. */
export function previewMediaUrl(file) {
  const url = `game-media://local/${randomUUID()}/${encodeURIComponent(basename(file))}`
  allowed.set(url, file)
  return { url, revoke: () => allowed.delete(url) }
}
/** Revoke all revisions of one deleted wallpaper without affecting its neighbours. */
export function revokeMediaFile(target) {
  for (const [url, file] of allowed) if (file === target) allowed.delete(url)
}
/**
 * Content types supported by local media playback, including application WAV effects.
 */
const TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.wav': 'audio/wav'
}
/**
 * Remove protocol capabilities for files below a deleted game cache so stale renderer URLs stop
 * resolving.
 *
 * @param {string} directory - Validated local destination or directory to inspect.
 */
export function revokeMediaDirectory(directory) {
  for (const [url, file] of allowed)
    if (file.startsWith(directory + '/') || file.startsWith(directory + '\\')) allowed.delete(url)
}
/**
 * Register a main-process file path and return an opaque game-media URL; null input stays null.
 * The renderer never receives arbitrary filesystem access.
 *
 * @param {string} file - Local file path, except ranking callbacks where it is an Archive file metadata entry.
 */
export function mediaUrl(file) {
  if (!file) return null
  // Replacing a cached file must also replace its renderer URL; otherwise Chromium can
  // keep displaying/playing the previous contents after an explicit rescrape.
  const stat = fs.statSync(file, { throwIfNoEntry: false })
  const key = createHash('sha256')
    .update(`${pathToFileURL(file).href}:${stat?.mtimeMs}:${stat?.size}`)
    .digest('hex')
  const url = `game-media://local/${key}/${encodeURIComponent(basename(file))}`
  allowed.set(url, file)
  return url
}

/** Resolve library-owned logo aliases in Main; Vite cannot display raw disk paths. */
export function gameLogoUrl(game) {
  for (const candidate of [game.media?.logo, game.logoUrl, game.clearLogo, game.logoPath]) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue
    if (allowed.has(candidate)) return candidate
    try {
      const file = candidate.startsWith('file:')
        ? fileURLToPath(candidate)
        : isAbsolute(candidate)
          ? candidate
          : game.mediaDirectory
            ? resolve(game.mediaDirectory, candidate)
            : null
      if (
        file &&
        /\.(png|jpg|webp)$/i.test(file) &&
        fs.statSync(file, { throwIfNoEntry: false })?.isFile()
      )
        return mediaUrl(file)
    } catch {
      /* Missing/stale aliases are optional; render the title instead. */
    }
  }
  return null
}

// Support Chromium's video/audio byte-range requests without buffering whole files.
/**
 * Serve only registered GET/HEAD requests, using streaming byte ranges for audio/video seeking.
 * Return 404 for missing files and 416 for invalid ranges.
 *
 * @param {Object} request - Launch payload or protocol Request, as specified by the surrounding handler.
 */
export function serveMedia(request) {
  const file = allowed.get(request.url)
  if (!file || !['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 404 })
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile()) return new Response(null, { status: 404 })
    const headers = {
      'Content-Type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
      'Accept-Ranges': 'bytes'
    }
    let start = 0
    let end = stat.size - 1
    const range = request.headers.get('range')
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range)
      if (!match || (!match[1] && !match[2]))
        return new Response(null, {
          status: 416,
          headers: { 'Content-Range': `bytes */${stat.size}` }
        })
      start = match[1] ? Number(match[1]) : Math.max(0, stat.size - Number(match[2]))
      end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end
      if (start > end || start >= stat.size)
        return new Response(null, {
          status: 416,
          headers: { 'Content-Range': `bytes */${stat.size}` }
        })
      headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`
    }
    headers['Content-Length'] = String(Math.max(0, end - start + 1))
    const body =
      request.method === 'HEAD' || !stat.size
        ? null
        : Readable.toWeb(fs.createReadStream(pathToFileURL(file), { start, end }))
    return new Response(body, { status: range ? 206 : 200, headers })
  } catch {
    return new Response(null, { status: 404 })
  }
}
