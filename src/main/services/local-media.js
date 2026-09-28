import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import { basename, extname } from 'node:path'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'

const allowed = new Map()
const TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.wav': 'audio/wav'
}
export function revokeMediaDirectory(directory) {
  for (const [url, file] of allowed)
    if (file.startsWith(directory + '/') || file.startsWith(directory + '\\')) allowed.delete(url)
}
export function mediaUrl(file) {
  if (!file) return null
  const key = createHash('sha256').update(pathToFileURL(file).href).digest('hex')
  const url = `game-media://local/${key}/${encodeURIComponent(basename(file))}`
  allowed.set(url, file)
  return url
}

// Support Chromium's video/audio byte-range requests without buffering whole files.
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
