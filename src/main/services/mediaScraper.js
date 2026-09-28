import fs from 'node:fs'
import { join, posix } from 'node:path'
import { mediaRoot, gameMediaDirectory } from './mediaPaths.js'

const ARCHIVE = 'https://archive.org'
const LIMIT = 5 * 1024 * 1024
const DAY = 86400000
const TARGETS = { music: 'theme.mp3', video: 'preview.mp4' }
const SYSTEMS = {
  PS2: ['Sony Playstation 2'],
  PS1: ['Sony Playstation'],
  PSP: ['Sony PSP', 'Sony Playstation Portable'],
  NDS: ['Nintendo DS'],
  GBA: ['Nintendo Game Boy Advance'],
  GBC: ['Nintendo Game Boy Color', 'Nintendo Game Boy'],
  GameCube: ['Nintendo GameCube'],
  Wii: ['Nintendo Wii'],
  N64: ['Nintendo 64'],
  SNES: ['Super Nintendo', 'Nintendo SNES'],
  NES: ['Nintendo NES', 'Nintendo Entertainment System'],
  '3DS': ['Nintendo 3DS'],
  Genesis: ['Sega Genesis', 'Sega Mega Drive'],
  Dreamcast: ['Sega Dreamcast']
}
const exists = (file) => fs.statSync(file, { throwIfNoEntry: false })?.isFile() === true
const normalized = (name) =>
  String(name)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '')
const stripTags = (name) =>
  String(name)
    .replace(/\([^)]*\)|\[[^\]]*\]/g, '')
    .trim()
const quoted = (title) => `"${title.replace(/[\\"]/g, '\\$&')}"`
const validId = (id) => typeof id === 'string' && /^[a-z\d][a-z\d._-]*$/i.test(id)
const restricted = (value) => value === true || value === 'true' || value === '1' || value === 1
const duration = (value) => {
  const parts = String(value ?? '')
    .split(':')
    .map(Number)
  return parts.reduce((seconds, part) => seconds * 60 + part, 0)
}

function allowed(url, binary) {
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false
  if (!binary)
    return (
      url.origin === ARCHIVE &&
      (url.pathname === '/advancedsearch.php' || url.pathname.startsWith('/metadata/'))
    )
  return (
    (url.hostname === 'archive.org' || url.hostname.endsWith('.archive.org')) &&
    (url.pathname.startsWith('/download/') || /^\/\d+\/items\//.test(url.pathname))
  )
}

// The deadline includes redirects and body streaming; length headers are only an early check.
async function request(url, { fetchImpl, timeoutMs }, onChunk) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let reader
  try {
    let current = new URL(url)
    let response
    for (let redirects = 0; redirects <= 4; redirects++) {
      if (!allowed(current, Boolean(onChunk))) throw Error('Unsupported archive URL')
      response = await fetchImpl(current.href, { signal: controller.signal, redirect: 'manual' })
      if (![301, 302, 303, 307, 308].includes(response.status)) break
      await response.body?.cancel()
      if (redirects === 4 || !response.headers.get('location')) throw Error('Redirect limit')
      current = new URL(response.headers.get('location'), current)
    }
    if (!response.ok || !response.body || Number(response.headers.get('content-length')) > LIMIT) {
      await response.body?.cancel()
      throw Error('Unavailable or oversized archive response')
    }
    reader = response.body.getReader()
    let size = 0
    const chunks = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > LIMIT) throw Error('Archive size limit')
      if (onChunk) await onChunk(value)
      else chunks.push(Buffer.from(value))
    }
    if (!size) throw Error('Empty archive response')
    return onChunk ? null : JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } finally {
    clearTimeout(timer)
    controller.abort()
    await reader?.cancel().catch(() => {})
  }
}

async function download(identifier, entry, kind, directory, options) {
  const target = join(directory, TARGETS[kind])
  const temporary = `${target}.part`
  let file
  try {
    if (exists(target)) return target
    await fs.promises.mkdir(directory, { recursive: true })
    file = await fs.promises.open(temporary, 'w')
    let prefix = Buffer.alloc(0)
    let size = 0
    const filePath = entry.name.split('/').map(encodeURIComponent).join('/')
    await request(
      `${ARCHIVE}/download/${encodeURIComponent(identifier)}/${filePath}`,
      options,
      async (chunk) => {
        size += chunk.length
        if (prefix.length < 64)
          prefix = Buffer.concat([prefix, Buffer.from(chunk).subarray(0, 64 - prefix.length)])
        let offset = 0
        while (offset < chunk.length) {
          const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset)
          if (!bytesWritten) throw Error('Incomplete cache write')
          offset += bytesWritten
        }
      }
    )
    const valid =
      kind === 'music'
        ? prefix.subarray(0, 3).toString() === 'ID3' ||
          (prefix[0] === 0xff && (prefix[1] & 0xe0) === 0xe0 && (prefix[1] & 0x06) !== 0)
        : prefix.subarray(4, 8).toString() === 'ftyp' &&
          prefix.readUInt32BE(0) >= 16 &&
          prefix.readUInt32BE(0) <= size
    if (size < 16 || !valid) throw Error('Invalid media response')
    await file.close()
    file = null
    await fs.promises.rename(temporary, target)
    return target
  } catch {
    return null
  } finally {
    await file?.close().catch(() => {})
    await fs.promises.rm(temporary, { force: true }).catch(() => {})
  }
}

function candidates(metadata, game, kind, pack) {
  if (
    !metadata ||
    metadata.is_dark ||
    restricted(metadata.metadata?.['access-restricted-item']) ||
    !Array.isArray(metadata.files)
  )
    return []
  return metadata.files
    .filter((file) => {
      if (typeof file.name !== 'string' || restricted(file.private) || restricted(file.restricted))
        return false
      if (
        file.name.includes('\\') ||
        file.name.split('/').some((part) => !part || part === '.' || part === '..')
      )
        return false
      if (!file.name.toLowerCase().endsWith(kind === 'music' ? '.mp3' : '.mp4')) return false
      if (Number(file.size) > LIMIT || Number(file.size) < 0) return false
      if (kind === 'video') {
        if (duration(file.length) > 60) return false
        const title = stripTags(
          posix.basename(file.original || file.name).replace(/(?:\.ia)?\.mp4$/i, '')
        )
        if (pack && normalized(title) !== normalized(game.title)) return false
      }
      return true
    })
    .sort((a, b) => {
      const score = (file) => {
        const seconds = duration(file.length)
        return (
          (kind === 'music' && /title|theme|menu/i.test(`${file.title || ''} ${file.name}`)
            ? 8
            : 0) +
          (seconds >= 15 && seconds <= 60 ? 2 : 0) +
          (game.region && file.name.toLowerCase().includes(`(${game.region.toLowerCase()})`)
            ? 4
            : 0)
        )
      }
      return score(b) - score(a)
    })
}

function matchesTitle(title, game, kind) {
  // Exact cleaned title avoids installing a sequel or compilation selected by phrase search.
  const cleaned = stripTags(title).replace(
    kind === 'music'
      ? /\s*[-:]?\s*(?:(?:original|official|video game|game)\s+)*(?:soundtrack|ost|theme)(?:\s+music)?\s*$/i
      : /\s*[-:]?\s*(?:video\s+snap|snap|preview|gameplay)(?:\s+video)?\s*$/i,
    ''
  )
  return normalized(cleaned) === normalized(game.title)
}

// Shared catalog requests are coalesced across games, but failed requests may retry on refresh.
export function createMediaDownloader({
  userData,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000
} = {}) {
  mediaRoot(userData)
  const options = { fetchImpl, timeoutMs }
  const cache = new Map()
  function json(url) {
    let cached = cache.get(url)
    if (!cached || Date.now() - cached.at > DAY) {
      const promise = request(url, options).catch((error) => {
        cache.delete(url)
        throw error
      })
      cached = { at: Date.now(), promise }
      cache.set(url, cached)
    }
    return cached.promise
  }
  async function search(q) {
    const query = new URLSearchParams({ q, 'fl[]': 'identifier,title', rows: '5', output: 'json' })
    const result = await json(`${ARCHIVE}/advancedsearch.php?${query}`)
    return Array.isArray(result?.response?.docs)
      ? result.response.docs.filter((doc) => validId(doc.identifier))
      : []
  }
  async function find(game, kind, directory) {
    let docs
    let pack = false
    if (kind === 'music') {
      docs = await search(`collection:(vgm_ost) AND title:(${quoted(game.title)})`)
      if (!docs.length) docs = await search(`mediatype:audio AND title:(${quoted(game.title)})`)
      docs = docs.filter((doc) => matchesTitle(doc.title || game.title, game, kind))
    } else {
      const systems = SYSTEMS[game.systemShort] || []
      const names = game.fileName?.toLowerCase().endsWith('.gb') ? ['Nintendo Game Boy'] : systems
      docs = names.length
        ? await search(`title:(${names.map(quoted).join(' OR ')}) AND title:("video snaps")`)
        : []
      docs = docs.filter((doc) =>
        names.some(
          (system) =>
            normalized(stripTags(doc.title || '').replace(/\(?video snaps\)?/gi, '')) ===
            normalized(system)
        )
      )
      pack = true
    }
    async function tryItems(items, isPack) {
      for (const doc of items.slice(0, 3)) {
        try {
          const metadata = await json(`${ARCHIVE}/metadata/${encodeURIComponent(doc.identifier)}`)
          for (const entry of candidates(metadata, game, kind, isPack).slice(0, 3)) {
            const target = await download(doc.identifier, entry, kind, directory, options)
            if (target) return target
          }
        } catch {
          /* An unavailable item does not prevent trying another public item. */
        }
      }
      return null
    }
    const target = await tryItems(docs, pack)
    if (target || kind === 'music') return target
    const individual = await search(
      `mediatype:movies AND title:(${quoted(game.title)}) AND (title:preview OR title:snap OR title:gameplay)`
    )
    return tryItems(
      individual.filter((doc) => matchesTitle(doc.title || '', game, kind)),
      false
    )
  }
  const run = async (game, { kinds = ['music', 'video'], onResult = () => {} } = {}) => {
    const result = { music: null, video: null }
    await Promise.all(
      kinds.map(async (kind) => {
        if (!Object.hasOwn(TARGETS, kind)) return
        try {
          const directory = gameMediaDirectory(userData, game.gameId)
          const cached = join(directory, TARGETS[kind])
          result[kind] = exists(cached) ? cached : await find(game, kind, directory)
        } catch {
          /* Music and video fail independently, leaving null and no UI error. */
        }
        try {
          await onResult(kind, result[kind])
        } catch {
          /* A closed renderer/cache error cannot cancel the other download. */
        }
      })
    )
    return result
  }
  run.clearCatalogs = () => cache.clear()
  return run
}
