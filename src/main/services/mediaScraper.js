import fs from 'node:fs'
import { join, posix } from 'node:path'
import { mediaRoot, gameMediaDirectory } from './mediaPaths.js'

/**
 * Official public Archive origin; requests require no API key.
 */
const ARCHIVE = 'https://archive.org'
/**
 * Five-MiB maximum response size, enforced on headers and streamed bytes.
 */
const LIMIT = 5 * 1024 * 1024
/**
 * One-day cache duration for shared Archive discovery requests.
 */
const DAY = 86400000
/**
 * Only these media kinds and fixed local filenames can be downloaded.
 */
const TARGETS = { music: 'theme.mp3', video: 'preview.mp4' }
/**
 * Platform aliases used to find matching Video Snaps packs; these are provider labels, not core
 * names.
 */
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
/**
 * Detect a previously cached regular media file before downloading again.
 *
 * @param {string} file - Local file path, except ranking callbacks where it is an Archive file metadata entry.
 */
const exists = (file) => fs.statSync(file, { throwIfNoEntry: false })?.isFile() === true
/**
 * Normalize accents and punctuation for exact game/platform title matching.
 *
 * @param {string} name - Filename or named action selected by the caller; accepted values are validated by this helper.
 */
const normalized = (name) =>
  String(name)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '')
/**
 * Remove bracketed release/region annotations from a remote or local title.
 *
 * @param {string} name - Filename or named action selected by the caller; accepted values are validated by this helper.
 */
const stripTags = (name) =>
  String(name)
    .replace(/\([^)]*\)|\[[^\]]*\]/g, '')
    .trim()
/**
 * Escape Archive query phrase delimiters without changing the requested game title.
 *
 * @param {string} title - Display title or cleaned game title to match.
 */
const quoted = (title) => `"${title.replace(/[\\"]/g, '\\$&')}"`
/**
 * Validate Archive item IDs before constructing metadata/download URLs.
 *
 * @param {*} id - Input used by this helper; see its operation contract above.
 */
const validId = (id) => typeof id === 'string' && /^[a-z\d][a-z\d._-]*$/i.test(id)
/**
 * Interpret the boolean/string restriction flags returned by Archive metadata.
 *
 * @param {*} value - Input value being normalized, displayed, or committed by this helper.
 */
const restricted = (value) => value === true || value === 'true' || value === '1' || value === 1
/**
 * Convert seconds or colon-separated track lengths into seconds for short-preview ranking.
 *
 * @param {*} value - Input value being normalized, displayed, or committed by this helper.
 */
const duration = (value) => {
  const parts = String(value ?? '')
    .split(':')
    .map(Number)
  return parts.reduce(
    /**
     * Accumulate parts into the value required by duration.
     *
     * @param {*} seconds - Value supplied by the enclosing operation; interpreted in this callback's local scope.
     * @param {*} part - Value supplied by the enclosing operation; interpreted in this callback's local scope.
     */
    (seconds, part) => seconds * 60 + part,
    0
  )
}

/**
 * Allow only HTTPS Archive search/metadata endpoints or Archive binary hosts and download paths;
 * reject credentials, ports, and unrelated redirects.
 *
 * @param {string|URL} url - Provider URL or parsed URL subject to the helper's origin/path policy.
 * @param {boolean} binary - Whether to use the binary-download endpoint policy rather than the JSON policy.
 */
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
/**
 * Apply one deadline and a five-MiB stream limit across redirects and body transfer. Return JSON
 * or await chunk writes, then always release network resources.
 *
 * @param {string|URL} url - Provider URL or parsed URL subject to the helper's origin/path policy.
 * @param {Object} options2 - Named inputs for this operation.
 * @param {Function} options2.fetchImpl - Injectable fetch implementation; defaults to global fetch and enables offline tests.
 * @param {number} options2.timeoutMs - Single request deadline in milliseconds.
 * @param {Function} onChunk - Optional async chunk consumer; supplied for streaming binary data instead of returning JSON.
 */
async function request(url, { fetchImpl, timeoutMs }, onChunk) {
  const controller = new AbortController()
  const timer = setTimeout(
    /**
     * Run delayed timer work only after the owning debounce/wait expires; the surrounding lifecycle owns cancellation.
     */
    () => controller.abort(),
    timeoutMs
  )
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
    await reader?.cancel().catch(
      /**
       * Handle the rejected stage of request here so its failure follows this operation's fallback/error policy.
       */
      () => {}
    )
  }
}

/**
 * Stream an MP3/MP4 to a temporary cache file, validate its signature, and rename only on
 * success. Missing content or I/O failure returns null and removes partial data.
 *
 * @param {string} identifier - Validated Archive item identifier.
 * @param {Object} entry - Provider file metadata selected for download.
 * @param {string} kind - Media category or modal type selecting this operation's behavior.
 * @param {string} directory - Validated local destination or directory to inspect.
 * @param {Object} options - Operation configuration; see destructured properties and defaults below.
 */
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
      /**
       * Complete the request callback step owned by download; caller arguments and captured state determine this stage's result.
       *
       * @param {*} chunk - Response bytes delivered by the stream.
       */
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
    await file?.close().catch(
      /**
       * Handle the rejected stage of download here so its failure follows this operation's fallback/error policy.
       */
      () => {}
    )
    await fs.promises.rm(temporary, { force: true }).catch(
      /**
       * Handle the rejected stage of download here so its failure follows this operation's fallback/error policy.
       */
      () => {}
    )
  }
}

/**
 * Reject restricted, unsafe, oversized, or wrong-format entries and rank suitable previews by
 * title/menu theme, duration, and region.
 *
 * @param {Object} metadata - Archive item metadata with public file candidates.
 * @param {Object} game - Library game record, including identity, platform, and available local media.
 * @param {string} kind - Media category or modal type selecting this operation's behavior.
 * @param {boolean} pack - Whether a video entry comes from a multi-game platform pack.
 */
function candidates(metadata, game, kind, pack) {
  if (
    !metadata ||
    metadata.is_dark ||
    restricted(metadata.metadata?.['access-restricted-item']) ||
    !Array.isArray(metadata.files)
  )
    return []
  return metadata.files
    .filter(
      /**
       * Retain only metadata.files entries satisfying candidates's local predicate; excluded values do not reach the next stage.
       *
       * @param {*} file - Value supplied by the enclosing operation; interpreted in this callback's local scope.
       */
      (file) => {
        if (
          typeof file.name !== 'string' ||
          restricted(file.private) ||
          restricted(file.restricted)
        )
          return false
        if (
          file.name.includes('\\') ||
          file.name.split('/').some(
            /**
             * Short-circuit when any file.name.split('/') entry meets candidates's condition.
             *
             * @param {*} part - Value supplied by the enclosing operation; interpreted in this callback's local scope.
             */
            (part) => !part || part === '.' || part === '..'
          )
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
      }
    )
    .sort(
      /**
       * Order metadata.files .filter((file) => { if (typeof file.name !== 'string' || restricted(file.private candidates deterministically before candidates consumes the preferred result.
       *
       * @param {*} a - Value supplied by the enclosing operation; interpreted in this callback's local scope.
       * @param {*} b - Value supplied by the enclosing operation; interpreted in this callback's local scope.
       */
      (a, b) => {
        /**
         * Prefer music title/theme/menu tracks, then 15–60 second clips and a matching region.
         *
         * @param {string} file - Local file path, except ranking callbacks where it is an Archive file metadata entry.
         */
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
      }
    )
}

/**
 * Require an exact cleaned game title after removing soundtrack/preview suffixes to avoid
 * unrelated sequels and compilations.
 *
 * @param {string} title - Display title or cleaned game title to match.
 * @param {Object} game - Library game record, including identity, platform, and available local media.
 * @param {string} kind - Media category or modal type selecting this operation's behavior.
 */
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
/**
 * Create an optional Archive media provider bound to userData with injected fetch and timeout.
 * Audio/video failures remain independent.
 *
 * @param {Object} options - Named inputs for this operation.
 * @param {string} options.userData - Absolute Electron userData directory; owns caches and persistent runtime state.
 * @param {Function} options.fetchImpl - Injectable fetch implementation; defaults to global fetch and enables offline tests.
 * @param {number} options.timeoutMs - Single request deadline in milliseconds.
 */
export function createMediaDownloader({
  userData,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000
} = {}) {
  mediaRoot(userData)
  /**
   * Injected fetch and one per-request timeout, shared across search, metadata, and streaming.
   */
  const options = { fetchImpl, timeoutMs }
  /**
   * Shared discovery promises with expiry; rejected requests are evicted for retry.
   */
  const cache = new Map()
  /**
   * Coalesce Archive metadata/search requests for one day and evict failed requests so manual
   * refresh can retry.
   *
   * @param {string|URL} url - Provider URL or parsed URL subject to the helper's origin/path policy.
   */
  function json(url) {
    let cached = cache.get(url)
    if (!cached || Date.now() - cached.at > DAY) {
      const promise = request(url, options).catch(
        /**
         * Handle the rejected stage of promise here so its failure follows this operation's fallback/error policy.
         *
         * @param {*} error - Failure from the preceding operation.
         */
        (error) => {
          cache.delete(url)
          throw error
        }
      )
      cached = { at: Date.now(), promise }
      cache.set(url, cached)
    }
    return cached.promise
  }
  /**
   * Query the public Archive advanced-search endpoint and retain only valid item identifiers.
   *
   * @param {string} q - Escaped Archive advanced-search query.
   */
  async function search(q) {
    const query = new URLSearchParams({ q, 'fl[]': 'identifier,title', rows: '5', output: 'json' })
    /**
     * Independent music/video results remain null when discovery or writing fails.
     */
    const result = await json(`${ARCHIVE}/advancedsearch.php?${query}`)
    return Array.isArray(result?.response?.docs)
      ? result.response.docs.filter(
          /**
           * Retain only result.response.docs entries satisfying search's local predicate; excluded values do not reach the next stage.
           *
           * @param {*} doc - Value supplied by the enclosing operation; interpreted in this callback's local scope.
           */
          (doc) => validId(doc.identifier)
        )
      : []
  }
  /**
   * Search OST collections or platform video packs, then fall back to matching individual items
   * and install the first usable preview.
   *
   * @param {Object} game - Library game record, including identity, platform, and available local media.
   * @param {string} kind - Media category or modal type selecting this operation's behavior.
   * @param {string} directory - Validated local destination or directory to inspect.
   */
  async function find(game, kind, directory) {
    let docs
    let pack = false
    if (kind === 'music') {
      docs = await search(`collection:(vgm_ost) AND title:(${quoted(game.title)})`)
      if (!docs.length) docs = await search(`mediatype:audio AND title:(${quoted(game.title)})`)
      docs = docs.filter(
        /**
         * Retain only docs entries satisfying find's local predicate; excluded values do not reach the next stage.
         *
         * @param {*} doc - Value supplied by the enclosing operation; interpreted in this callback's local scope.
         */
        (doc) => matchesTitle(doc.title || game.title, game, kind)
      )
    } else {
      const systems = SYSTEMS[game.systemShort] || []
      const names = game.fileName?.toLowerCase().endsWith('.gb') ? ['Nintendo Game Boy'] : systems
      docs = names.length
        ? await search(`title:(${names.map(quoted).join(' OR ')}) AND title:("video snaps")`)
        : []
      docs = docs.filter(
        /**
         * Retain only docs entries satisfying find's local predicate; excluded values do not reach the next stage.
         *
         * @param {*} doc - Value supplied by the enclosing operation; interpreted in this callback's local scope.
         */
        (doc) =>
          names.some(
            /**
             * Short-circuit when any names entry meets find's condition.
             *
             * @param {*} system - Value supplied by the enclosing operation; interpreted in this callback's local scope.
             */
            (system) =>
              normalized(stripTags(doc.title || '').replace(/\(?video snaps\)?/gi, '')) ===
              normalized(system)
          )
      )
      pack = true
    }
    /**
     * Try at most three matching items and three eligible files per item, tolerating unavailable
     * archives.
     *
     * @param {Array} items - Candidate items to inspect in order.
     * @param {boolean} isPack - Whether exact per-file title matching is required for a platform pack.
     */
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
      individual.filter(
        /**
         * Retain only individual entries satisfying find's local predicate; excluded values do not reach the next stage.
         *
         * @param {*} doc - Value supplied by the enclosing operation; interpreted in this callback's local scope.
         */
        (doc) => matchesTitle(doc.title || '', game, kind)
      ),
      false
    )
  }
  /**
   * Fetch requested music/video kinds concurrently into the validated game cache and report each
   * result independently, including null misses.
   *
   * @param {Object} game - Library game record, including identity, platform, and available local media.
   * @param {Object} options2 - Named inputs for this operation.
   * @param {string[]} options2.kinds - Requested optional preview kinds: music and/or video.
   * @param {Function} options2.onResult - Receives a completed media kind and its local path or null.
   */
  const run = async (
    game,
    {
      kinds = ['music', 'video'],
      onResult /**
       * Optional notification defaults to a no-op so callers can omit a progress callback.
       */ = () => {}
    } = {}
  ) => {
    /**
     * Independent music/video results remain null when discovery or writing fails.
     */
    const result = { music: null, video: null }
    await Promise.all(
      kinds.map(
        /**
         * Project each kinds entry for run; preserve input ordering in the derived collection.
         *
         * @param {*} kind - Value supplied by the enclosing operation; interpreted in this callback's local scope.
         */
        async (kind) => {
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
        }
      )
    )
    return result
  }
  run.clearCatalogs =
    /**
     * Clear provider lookup cache for an explicit retry without changing already downloaded files.
     */
    () => cache.clear()
  return run
}
