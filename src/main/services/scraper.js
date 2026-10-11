import {
  createPs3IsoExtractor,
  cachedPs3IsoMedia,
  cachedPs3IsoTitleId,
  normalizePs3TitleId
} from './ps3IsoMedia.js'
import { mediaPreferences } from './preferences.js'
import fs from 'node:fs'
import { join, parse, extname } from 'node:path'
import { createHash } from 'node:crypto'
import { readPs3EmbeddedMedia, readPs3FolderTitle, readPs3FolderTitleId } from './rpcs3Library.js'
import { createMediaDownloader } from './mediaScraper.js'
import { mediaRoot as getMediaRoot, gameMediaDirectory } from './mediaPaths.js'

/**
 * Trusted Libretro artwork origin; platform and kind maps determine the only requested directory
 * paths.
 */
const CDN = 'https://thumbnails.libretro.com/'
/**
 * Libretro thumbnail directory names keyed by the shared platform IDs; missing mappings retain
 * local artwork.
 */
const SYSTEMS = {
  PS3: 'Sony - PlayStation 3',
  PS2: 'Sony - PlayStation 2',
  PS1: 'Sony - PlayStation',
  PSP: 'Sony - PlayStation Portable',
  NDS: 'Nintendo - Nintendo DS',
  GBA: 'Nintendo - Game Boy Advance',
  GBC: 'Nintendo - Game Boy Color',
  GameCube: 'Nintendo - GameCube',
  Wii: 'Nintendo - Wii',
  N64: 'Nintendo - Nintendo 64',
  SNES: 'Nintendo - Super Nintendo Entertainment System',
  NES: 'Nintendo - Nintendo Entertainment System',
  '3DS': 'Nintendo - Nintendo 3DS',
  Genesis: 'Sega - Mega Drive - Genesis',
  Dreamcast: 'Sega - Dreamcast'
}
/**
 * Public media field to Libretro thumbnail category mapping.
 */
const KINDS = { boxart: 'Named_Boxarts', snap: 'Named_Snaps', titleScreen: 'Named_Titles' }
/**
 * Fixed cache basenames; remote filenames never choose filesystem destinations.
 */
const NAMES = { boxart: 'boxart.png', snap: 'snap.png', titleScreen: 'title.png', logo: 'logo.png' }
/**
 * Milliseconds between automatic retries of missing artwork or preview kinds.
 */
const DAY = 24 * 60 * 60 * 1000
/**
 * Expected PNG magic bytes, checked before a download is published as artwork.
 */
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

/**
 * Remove extension and bracketed tags for display while preserving a recognized region for
 * artwork matching.
 *
 * @param {string} fileName - Filename used for platform detection, catalog matching, or core-family lookup.
 */
export function cleanGameName(fileName) {
  const name = parse(fileName).name
  const region =
    name.match(/\((USA|Europe|Japan|World|UK|Australia|Korea|China)(?:[, )])/i)?.[1] || null
  const title =
    name
      .replace(/\s*(\([^)]*\)|\[[^\]]*\])/g, '')
      .replace(/\s+/g, ' ')
      .trim() || name
  return { title, region }
}

/**
 * Build a stable cache ID from platform, cleaned title, filename, and optional import identity;
 * hash suffixes distinguish releases.
 *
 * @param {Object} game - Library game record, including identity, platform, and available local media.
 */
export function gameMediaId(game) {
  const slug =
    (game.rpcs3Installed ? game.titleId : cleanGameName(game.fileName).title)
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'game'
  const hash = createHash('sha256')
    .update(`${game.systemShort}:${game.fileName}${game.importKey ? ':' + game.importKey : ''}`)
    .digest('hex')
    .slice(0, 12)
  return `${game.systemShort.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${slug}-${hash}`
}

/**
 * Compare cleaned artwork titles without case, accent, or punctuation differences.
 *
 * @param {string} name - Filename or named action selected by the caller; accepted values are validated by this helper.
 */
const normalized = (name) =>
  cleanGameName(`${name}.png`)
    .title.normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
/**
 * Test for a physical cached media file rather than trusting the manifest.
 *
 * @param {string} file - Local file path, except ranking callbacks where it is an Archive file metadata entry.
 */
const exists = (file) => {
  const stat = fs.statSync(file, { throwIfNoEntry: false })
  return stat?.isFile() === true && stat.size > 0
}

// Dependency injection keeps CDN tests offline and never needs credentials.
/**
 * Coordinate two artwork workers and a separate optional media queue. Persist a shared
 * games.json manifest and notify the renderer as previews arrive.
 *
 * @param {Object} options - Named inputs for this operation.
 * @param {string} options.userData - Absolute Electron userData directory; owns caches and persistent runtime state.
 * @param {Function} options.fetchImpl - Injectable fetch implementation; defaults to global fetch and enables offline tests.
 * @param {Function} options.onMediaUpdated - Receives a game after an independent preview file becomes available.
 * @param {number} options.mediaTimeoutMs - Deadline in milliseconds for optional audio/video requests.
 */
export function createScraper({
  userData,
  fetchImpl = globalThis.fetch,
  onMediaUpdated /**
   * Optional notification defaults to a no-op so callers can omit a progress callback.
   */ = () => {},
  getPreferences = () => ({}),
  extractIso = createPs3IsoExtractor({ userData }),
  onDownload = () => {},
  logger = console,
  mediaTimeoutMs = 15000
}) {
  /**
   * Validated userData media root, also used for read-only legacy preview fallbacks.
   */
  const mediaRoot = getMediaRoot(userData)
  /**
   * Scraper manifest path, separate from library.json imported/excluded ROM paths.
   */
  const manifest = join(userData, 'games.json')
  /**
   * In-memory persisted metadata snapshot; mutate only through the serialized saveRecords queue.
   */
  let records = {}
  try {
    records = JSON.parse(fs.readFileSync(manifest, 'utf8')).games || {}
  } catch {
    /* First run or damaged cache. */
  }
  /**
   * Per-scan shared CDN listing promises to avoid fetching the same directory for every game.
   */
  const catalogs = new Map()
  /**
   * Single active scan Promise shared by overlapping callers.
   */
  let inFlight = null
  /**
   * Latest scanned game records; missing entries suppress stale background media notifications.
   */
  let activeGames = new Map()
  /**
   * Serializes atomic games.json writes from independently finishing artwork and preview
   * downloads.
   */
  let manifestQueue = Promise.resolve()
  /**
   * Processes one game's optional previews at a time without blocking the artwork scan.
   */
  let mediaQueue = Promise.resolve()
  /**
   * Deduplicates games already waiting in the optional media queue.
   */
  const pendingMedia = new Set()
  // Tokens let explicit retries supersede queued automatic jobs without duplicate writes.
  const mediaTokens = new Map()
  const mediaTasks = new Map()
  /**
   * Deletion tombstones checked before and after network work to prevent cache resurrection.
   */
  const removed = new Set()
  /**
   * Per-game active preview tasks that deletion must await.
   */
  const runningMedia = new Map()
  const preferenceKey = {
    boxart: 'downloadCovers',
    logo: 'downloadCovers',
    snap: 'downloadBackgrounds',
    titleScreen: 'downloadBackgrounds',
    fanart: 'downloadBackgrounds',
    video: 'downloadVideos',
    music: 'downloadAudio'
  }
  const allowed = (kind) => mediaPreferences(getPreferences())[preferenceKey[kind]] === true
  // A removed/truncated cache entry is repairable immediately; negative lookups keep their cooldown.
  const lostCache = (game, kind) => {
    const file = records[game.gameId]?.media?.[kind === 'fanart' ? 'snap' : kind]
    return Boolean(file) && !exists(file)
  }
  const log = (message) => logger.log('[Scraper] ' + message)
  const controllers = new Map()
  const guardedFetch =
    (kind) =>
    async (url, options = {}) => {
      if (!allowed(kind)) throw Error('Media download disabled')
      let controller = controllers.get(kind)
      if (!controller || controller.signal.aborted)
        controllers.set(kind, (controller = new AbortController()))
      log('Sorgulanan URL: ' + url)
      try {
        const response = await fetchImpl(url, {
          ...options,
          signal: options.signal
            ? AbortSignal.any([options.signal, controller.signal])
            : controller.signal
        })
        if (!response.ok)
          log('Başarısız İndirmeler: ' + kind + ' HTTP ' + response.status + ' ' + url)
        return response
      } catch (error) {
        log('Başarısız İndirmeler: ' + kind + ' ' + error.message)
        throw error
      }
    }
  const cancelDisabledRequests = () => {
    for (const [kind, controller] of controllers) if (!allowed(kind)) controller.abort()
  }
  const downloaders = Object.fromEntries(
    ['music', 'video', 'logo', 'boxart', 'fanart'].map((kind) => [
      kind,
      createMediaDownloader({
        userData,
        fetchImpl: guardedFetch(kind),
        timeoutMs: mediaTimeoutMs,
        onDiagnostic: log,
        onDownload
      })
    ])
  )

  // Images and audio finish independently; serialize manifest mutations to avoid lost updates.
  /**
   * Serialize read-modify-write manifest mutations so independently finishing artwork and media
   * cannot erase each other's updates.
   *
   * @param {Function} change - Manifest mutation run inside the serialized write queue.
   */
  function saveRecords(change) {
    const write = manifestQueue
      .catch(
        /**
         * Handle the rejected stage of write here so its failure follows this operation's fallback/error policy.
         */
        () => {}
      )
      .then(
        /**
         * Continue write after the preceding asynchronous stage resolves; the returned value or Promise feeds the same chain.
         */
        async () => {
          change()
          await fs.promises.mkdir(userData, { recursive: true })
          await fs.promises.writeFile(
            `${manifest}.tmp`,
            JSON.stringify({ version: 1, games: records }, null, 2)
          )
          await fs.promises.rename(`${manifest}.tmp`, manifest)
        }
      )
    manifestQueue = write
    return write
  }

  /**
   * Create the persisted metadata record, retaining previous provider timestamps while refreshing
   * physical media paths.
   *
   * @param {Object} game - Library game record, including identity, platform, and available local media.
   * @param {Object} previous - Existing persisted record whose timestamps/metadata should survive an update.
   */
  function recordFor(game, previous = {}) {
    return {
      gameId: game.gameId,
      fileName: game.fileName,
      region: game.region,
      year: null,
      developer: null,
      genre: null,
      ...previous,
      title: game.title,
      platform: game.systemShort,
      titleId: game.titleId || null,
      ...(game.rpcs3Installed ? { title: game.title, titleId: game.titleId, path: game.path } : {}),
      media: game.media
    }
  }

  /**
   * Schedule missing music/video independently of artwork, honor per-kind cooldowns, and skip
   * removed games before queued writes start.
   *
   * @param {*} games - Input used by this helper; see its operation contract above.
   * @param {boolean} force - Bypass provider lookup cooldowns for an explicit rescan.
   */
  function queueMedia(games, force, priority = false) {
    if (force) for (const provider of Object.values(downloaders)) provider.clearCatalogs()
    for (const original of games) {
      const game = enrich(original)
      removed.delete(game.gameId)
      if (pendingMedia.has(game.gameId)) continue
      if (!force && ['boxart', 'snap', 'music', 'video'].every((kind) => game.media[kind])) continue
      const kinds = (
        game.systemShort === 'PS3'
          ? ['music', 'video', 'logo', 'boxart', 'fanart']
          : ['music', 'video']
      ).filter(
        /**
         * Retain only ['music', 'video'] entries satisfying kinds's local predicate; excluded values do not reach the next stage.
         *
         * @param {*} kind - Value supplied by the enclosing operation; interpreted in this callback's local scope.
         */
        (kind) =>
          allowed(kind) &&
          (force ||
            !(kind === 'boxart' || kind === 'fanart'
              ? exists(join(game.mediaDirectory, NAMES[kind === 'fanart' ? 'snap' : 'boxart'])) ||
                exists(
                  join(game.mediaDirectory, kind === 'boxart' ? 'cover-hd.png' : 'fanart.png')
                ) ||
                (kind === 'boxart' && exists(join(game.mediaDirectory, 'cover-gametdb.jpg')))
              : game.media[kind])) &&
          (force ||
            lostCache(game, kind) ||
            (kind === 'boxart' &&
              game.titleId &&
              records[game.gameId]?.coverTitleId !== game.titleId) ||
            Date.now() - (records[game.gameId]?.archiveCheckedAt?.[kind] || 0) >= DAY)
      )
      if (!kinds.length) continue
      pendingMedia.add(game.gameId)
      const token = {}
      mediaTokens.set(game.gameId, token)
      // A manual request bypasses other games' optional previews; its own active job is awaited.
      const scheduled = (priority ? Promise.resolve() : mediaQueue)
        .then(
          /**
           * Continue queueMedia after the preceding asynchronous stage resolves; the returned value or Promise feeds the same chain.
           */
          async () => {
            if (
              mediaTokens.get(game.gameId) !== token ||
              !activeGames.has(game.gameId) ||
              removed.has(game.gameId)
            )
              return
            const task = Promise.all(
              kinds.filter(allowed).map((kind) =>
                downloaders[kind](enrich(game), {
                  kinds: [kind],
                  force,
                  /**
                   * Merge a completed media lookup into the manifest and notify only if the game still exists and
                   * a usable file was downloaded.
                   *
                   * @param {string} kind - Media category or modal type selecting this operation's behavior.
                   * @param {*} path - Input used by this helper; see its operation contract above.
                   */
                  onResult: async (kind, path) => {
                    log(
                      (path ? 'Başarılı' : 'Başarısız') +
                        ' İndirmeler: ' +
                        game.title +
                        ' / ' +
                        kind +
                        (path
                          ? ' → ' + path
                          : ' (bulunamadı, geçersiz yanıt veya indirme hatası; yerel dosya korunur)')
                    )
                    if (!allowed(kind)) return
                    let updated
                    await saveRecords(
                      /**
                       * Mutate task's manifest only inside the serialized write queue to avoid lost concurrent updates.
                       */
                      () => {
                        const current = activeGames.get(game.gameId)
                        if (!current) return
                        updated = enrich(current)
                        const previous = records[game.gameId]
                        records[game.gameId] = recordFor(updated, {
                          ...previous,
                          archiveCheckedAt: { ...previous?.archiveCheckedAt, [kind]: Date.now() },
                          ...(kind === 'boxart' ? { coverTitleId: game.titleId || null } : {})
                        })
                      }
                    )
                    if (path && updated && activeGames.has(game.gameId)) onMediaUpdated(updated)
                  }
                })
              )
            )
            runningMedia.set(game.gameId, task)
            try {
              await task
            } finally {
              runningMedia.delete(game.gameId)
            }
          }
        )
        .catch(
          /**
           * Handle the rejected stage of queueMedia here so its failure follows this operation's fallback/error policy.
           */
          () => {
            /* Preview media is optional, including cache writes and closed renderer listeners. */
          }
        )
        .finally(
          /**
           * Release queueMedia's pending-work bookkeeping after either success or failure.
           */
          () => {
            if (mediaTokens.get(game.gameId) === token) {
              pendingMedia.delete(game.gameId)
              mediaTokens.delete(game.gameId)
              mediaTasks.delete(game.gameId)
            }
          }
        )
      mediaTasks.set(game.gameId, scheduled)
      if (!priority) mediaQueue = scheduled
    }
  }

  /**
   * Derive cleaned metadata and cache paths from the game record; prefer per-game files to legacy
   * userData music/video fallbacks.
   *
   * @param {Object} game - Library game record, including identity, platform, and available local media.
   */
  function enrich(game) {
    const gameId = gameMediaId(game)
    // Rescanning recreates ROM records. Rehydrate presentation fields from games.json,
    // but never restore cached executable paths or platform assignments over the scanner.
    const saved = records[gameId] || {}
    const presentation = Object.fromEntries(
      [
        'year',
        'releaseYear',
        'releaseDate',
        'genre',
        'genres',
        'category',
        'publisher',
        'developer',
        'synopsis',
        'overview',
        'description',
        'plot',
        'summary',
        'clearLogo',
        'logoPath',
        'format'
      ].map((key) => [key, game[key] ?? saved[key] ?? null])
    )
    const folderTitle = readPs3FolderTitle(game)
    const metadata =
      game.rpcs3Installed || folderTitle
        ? { title: folderTitle || game.title, region: null }
        : cleanGameName(game.fileName)
    const directory = gameMediaDirectory(userData, gameId)
    const media = Object.fromEntries(
      Object.entries(NAMES).map(
        /**
         * Project each Object.entries(NAMES) entry for media; preserve input ordering in the derived collection.
         *
         * @param {*} input1 - Value supplied by the enclosing operation; interpreted in this callback's local scope.
         */
        ([kind, name]) => {
          const file = join(directory, name)
          return [kind, exists(file) ? file : null]
        }
      )
    )
    // Online cache first; game-owned art is the offline fallback.
    const embedded = {
      ...readPs3EmbeddedMedia(game),
      ...cachedPs3IsoMedia(userData, { ...game, gameId })
    }
    for (const [kind, file] of Object.entries(embedded))
      if (!media[kind] && file) media[kind] = file
    for (const [kind, name] of [
      ['boxart', 'cover-hd.png'],
      ['boxart', 'cover-gametdb.jpg'],
      ['snap', 'fanart.png']
    ]) {
      const file = join(directory, name)
      if (exists(file)) media[kind] = file
    }
    for (const [kind, folder, suffix, cachedName] of [
      ['music', 'music', 'mp3', 'theme.mp3'],
      ['video', 'videos', 'mp4', 'preview.mp4']
    ]) {
      media[kind] =
        [join(directory, cachedName), join(mediaRoot, folder, `${gameId}.${suffix}`)].find(
          exists
        ) || null
    }
    const titleId =
      normalizePs3TitleId(game.titleId) ||
      readPs3FolderTitleId(game) ||
      cachedPs3IsoTitleId(userData, { ...game, gameId })
    return {
      ...game,
      ...presentation,
      ...metadata,
      region: metadata.region || game.region || saved.region || null,
      titleId,
      gameId,
      media,
      mediaDirectory: directory
    }
  }

  /**
   * Fetch a bounded Libretro response with an eight-second timeout; 404 is a cache miss and other
   * failures stop online artwork work.
   *
   * @param {string|URL} url - Provider URL or parsed URL subject to the helper's origin/path policy.
   * @param {number} limit - Maximum accepted response bytes.
   */
  async function request(url, limit, kind, progress = () => {}) {
    const response = await guardedFetch(kind)(url, {
      signal: AbortSignal.timeout(8000),
      redirect: 'error'
    })
    if (response.status === 404) {
      await response.body?.cancel()
      return null
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`Libretro HTTP ${response.status}`)
    }
    if (Number(response.headers.get('content-length')) > limit) {
      await response.body?.cancel()
      throw new Error('Medya boyutu sınırı aşıldı')
    }
    const reader = response.body.getReader()
    const chunks = []
    let size = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.length
        if (size > limit) throw new Error('Medya boyutu sınırı aşıldı')
        chunks.push(Buffer.from(value))
        progress({ received: size, total: Number(response.headers.get('content-length')) || null })
      }
    } finally {
      await reader.cancel()
    }
    return Buffer.concat(chunks)
  }

  /**
   * Cache a platform/media-kind directory listing while rejecting links outside the trusted CDN
   * directory and non-PNG files.
   *
   * @param {string} system - Console ID from the shared platform registry.
   * @param {string} kind - Media category or modal type selecting this operation's behavior.
   */
  async function catalog(system, kind) {
    const base = `${CDN}${encodeURIComponent(system)}/${KINDS[kind]}/`
    if (!catalogs.has(base)) {
      catalogs.set(
        base,
        (
          /**
           * Complete the enclosing callback step owned by catalog; caller arguments and captured state determine this stage's result.
           */
          async () => {
            const html = (await request(base, 8 * 1024 * 1024, kind))?.toString('utf8') || ''
            const entries = []
            for (const match of html.matchAll(/href=["']([^"']+)["']/gi)) {
              try {
                const url = new URL(match[1].replace(/&amp;/g, '&'), base)
                if (url.origin !== new URL(CDN).origin || !url.href.startsWith(base) || url.search)
                  continue
                const name = decodeURIComponent(url.pathname.slice(new URL(base).pathname.length))
                if (name.includes('/') || !name.toLowerCase().endsWith('.png')) continue
                entries.push({ name, url: url.href, ...cleanGameName(name) })
              } catch {
                /* Ignore malformed links in an external listing. */
              }
            }
            return entries
          }
        )()
      )
    }
    return catalogs.get(base)
  }

  /**
   * Share an active scan, run two artwork workers, merge preview results into games.json, and
   * return usable local games even when CDN access fails.
   *
   * @param {*} games - Input used by this helper; see its operation contract above.
   * @param {Function} onProgress - Receives per-game artwork progress and optional warnings.
   * @param {Object} options3 - Named inputs for this operation.
   * @param {boolean} options3.force - Bypass provider lookup cooldowns for an explicit rescan.
   */
  async function scan(
    games,
    onProgress /**
     * Optional notification defaults to a no-op so callers can omit a progress callback.
     */ = () => {},
    { force = false, gameId: targetId = null } = {}
  ) {
    if (inFlight) {
      if (!targetId) return inFlight
      await inFlight
      return scan(games, onProgress, { force, gameId: targetId })
    }
    if (targetId && force) {
      mediaTokens.delete(targetId)
      pendingMedia.delete(targetId)
      mediaTasks.delete(targetId)
      await runningMedia.get(targetId)
      if (inFlight) return scan(games, onProgress, { force, gameId: targetId })
      if (removed.has(targetId)) throw Error('Game is no longer in the library.')
    }
    inFlight = (
      /**
       * Complete the enclosing callback step owned by scan; caller arguments and captured state determine this stage's result.
       */
      async () => {
        activeGames = new Map(
          games.map(
            /**
             * Project each games entry for scan; preserve input ordering in the derived collection.
             *
             * @param {*} game - Value supplied by the enclosing operation; interpreted in this callback's local scope.
             */
            (game) => [gameMediaId(game), game]
          )
        )
        for (const original of games.filter(
          (entry) => !targetId || gameMediaId(entry) === targetId
        )) {
          const game = enrich(original),
            prefs = mediaPreferences(getPreferences())
          log('İstek alındı: ' + game.title + ' (' + game.systemShort + ')')
          log(
            'Ayarlar: Kapak: ' +
              prefs.downloadCovers +
              ', Fanart: ' +
              prefs.downloadBackgrounds +
              ', Video: ' +
              prefs.downloadVideos +
              ', Ses: ' +
              prefs.downloadAudio
          )
        }
        catalogs.clear()
        let offline = false
        let warning = null
        let completed = 0
        let cursor = 0
        const nextRecords = {}
        const output = new Array(games.length)
        /**
         * Claim the next ROM index, rank exact title/region artwork matches, publish validated PNGs, and
         * report progress while honoring deletion tombstones.
         */
        const worker = async () => {
          while (cursor < games.length) {
            const index = cursor++
            let game = enrich(games[index])
            if (removed.has(game.gameId)) continue
            const complete = ['boxart', 'snap', 'music', 'video'].every((kind) => game.media[kind])
            if ((force || !complete) && (!targetId || targetId === game.gameId))
              await extractIso(game, { force }).catch(() => {})
            game = enrich(game)
            if (!targetId || game.gameId === targetId) queueMedia([game], force, Boolean(targetId))
            const previous = records[game.gameId]
            let checkedAt = previous?.checkedAt || 0
            const artworkCheckedAt = { ...previous?.artworkCheckedAt }
            if (
              (!targetId || game.gameId === targetId) &&
              (force || !complete) &&
              (allowed('boxart') || allowed('snap')) &&
              !offline &&
              (force ||
                Object.keys(KINDS).some(
                  (kind) =>
                    allowed(kind) &&
                    (lostCache(game, kind) || Date.now() - (artworkCheckedAt[kind] || 0) > DAY)
                ))
            ) {
              let artworkFailed = false
              try {
                const system =
                  extname(game.fileName).toLowerCase() === '.gb'
                    ? 'Nintendo - Game Boy'
                    : SYSTEMS[game.systemShort]
                if (system) {
                  for (const kind of Object.keys(KINDS)) {
                    if (removed.has(game.gameId)) break
                    if (
                      (!force && game.media[kind]) ||
                      (!force &&
                        !lostCache(game, kind) &&
                        Date.now() - (artworkCheckedAt[kind] || 0) < DAY) ||
                      offline ||
                      !allowed(kind)
                    )
                      continue
                    try {
                      const entries = await catalog(system, kind)
                      const candidates = entries.filter(
                        /**
                         * Retain only entries entries satisfying candidates's local predicate; excluded values do not reach the next stage.
                         *
                         * @param {*} entry - Value supplied by the enclosing operation; interpreted in this callback's local scope.
                         */
                        (entry) => normalized(entry.title) === normalized(game.title)
                      )
                      candidates.sort(
                        /**
                         * Order candidates candidates deterministically before worker consumes the preferred result.
                         *
                         * @param {*} a - Value supplied by the enclosing operation; interpreted in this callback's local scope.
                         * @param {*} b - Value supplied by the enclosing operation; interpreted in this callback's local scope.
                         */
                        (a, b) => {
                          /**
                           * Rank exact release filenames above region matches, using USA as a deterministic preference
                           * when otherwise tied.
                           *
                           * @param {Object} item - Artwork candidate being ranked.
                           */
                          const score = (item) =>
                            (item.region?.toLowerCase() === game.region?.toLowerCase() ? 4 : 0) +
                            (item.name.slice(0, -4) === parse(game.fileName).name ? 8 : 0) +
                            (item.region === 'USA' ? 1 : 0)
                          return score(b) - score(a) || a.name.localeCompare(b.name)
                        }
                      )
                      if (!candidates.length) {
                        artworkCheckedAt[kind] = Date.now()
                        log(
                          'Başarısız İndirmeler: ' +
                            game.title +
                            ' / ' +
                            kind +
                            ' (eşleşme bulunamadı)'
                        )
                        continue
                      }
                      const report = (value) =>
                        onDownload({
                          id: 'thumbnail:' + game.gameId + ':' + kind,
                          name: game.title,
                          kind,
                          ...value
                        })
                      report({ status: 'active', phase: 'downloading', percent: null })
                      const bytes = await request(
                        candidates[0].url,
                        20 * 1024 * 1024,
                        kind,
                        (value) => report({ status: 'active', ...value })
                      )
                      if (removed.has(game.gameId)) break
                      if (!allowed(kind) || !bytes) {
                        report({ status: 'unavailable' })
                        continue
                      }
                      if (!bytes.subarray(0, 8).equals(PNG)) throw new Error('Geçersiz PNG yanıtı')
                      await fs.promises.mkdir(game.mediaDirectory, { recursive: true })
                      const target = join(game.mediaDirectory, NAMES[kind])
                      await fs.promises.writeFile(`${target}.tmp`, bytes)
                      await fs.promises.rename(`${target}.tmp`, target)
                      report({ status: 'completed' })
                      artworkCheckedAt[kind] = Date.now()
                      log('Başarılı İndirmeler: ' + game.title + ' / ' + kind + ' → ' + target)
                    } catch (error) {
                      onDownload({
                        id: 'thumbnail:' + game.gameId + ':' + kind,
                        name: game.title,
                        kind,
                        status: 'failed',
                        error: error.message
                      })
                      artworkFailed = true
                      log(
                        'Başarısız İndirmeler: ' + game.title + ' / ' + kind + ': ' + error.message
                      )
                      if (allowed(kind))
                        warning =
                          'Medya indirilemedi; yerel önbellek kullanılıyor. ' + error.message
                    }
                  }
                }
                if (!offline && !artworkFailed) checkedAt = Date.now()
              } catch (error) {
                offline = true
                log('Başarısız İndirmeler: ' + game.title + ' / CDN: ' + error.message)
                if (allowed('boxart') || allowed('snap'))
                  warning = `Medya indirilemedi; yerel önbellek kullanılıyor. ${error.message}`
              }
            }
            game = enrich(game)
            if (removed.has(game.gameId)) continue
            nextRecords[game.gameId] = recordFor(game, { ...previous, checkedAt, artworkCheckedAt })
            output[index] = game
            onProgress({ completed: ++completed, total: games.length, game, warning })
          }
        }
        await Promise.all([worker(), worker()])
        await saveRecords(
          /**
           * Mutate scan's manifest only inside the serialized write queue to avoid lost concurrent updates.
           */
          () => {
            for (const game of output) {
              if (!game || removed.has(game.gameId)) continue
              nextRecords[game.gameId].archiveCheckedAt =
                records[game.gameId]?.archiveCheckedAt || {}
              nextRecords[game.gameId].coverTitleId = records[game.gameId]?.coverTitleId || null
              nextRecords[game.gameId].media = enrich(game).media
            }
            records = Object.fromEntries(
              Object.entries(nextRecords).filter(
                /**
                 * Retain only Object.entries(nextRecords) entries satisfying scan's local predicate; excluded values do not reach the next stage.
                 *
                 * @param {*} input1 - Value supplied by the enclosing operation; interpreted in this callback's local scope.
                 */
                ([id]) => !removed.has(id)
              )
            )
          }
        )
        return {
          games: output
            .filter(
              /**
               * Retain only output entries satisfying scan's local predicate; excluded values do not reach the next stage.
               *
               * @param {*} game - Value supplied by the enclosing operation; interpreted in this callback's local scope.
               */
              (game) => game && !removed.has(game.gameId)
            )
            .map(enrich),
          warning
        }
      }
    )().finally(
      /**
       * Release scan's pending-work bookkeeping after either success or failure.
       */
      () => {
        inFlight = null
      }
    )
    return inFlight
  }
  /**
   * Mark the game removed before awaiting active writes and deleting its manifest record,
   * preventing late downloads from resurrecting cache data.
   *
   * @param {string} gameId - Stable library/media identity; Main resolves or validates it before accessing files.
   */
  const forget = async (gameId) => {
    removed.add(gameId)
    activeGames.delete(gameId)
    await Promise.allSettled([inFlight, runningMedia.get(gameId)])
    await saveRecords(
      /**
       * Mutate forget's manifest only inside the serialized write queue to avoid lost concurrent updates.
       */
      () => {
        delete records[gameId]
      }
    )
  }
  /** Manual retries await previews too; a pending automatic job cannot swallow the request. */
  const rescrape = async (games, gameId, onProgress) => {
    const original = games.find((game) => gameMediaId(game) === gameId)
    if (!original) throw Error('Game is not in the library.')
    log('Yeniden arama kuyruğa alındı: ' + enrich(original).title)
    const result = await scan(games, onProgress, { force: true, gameId })
    await mediaTasks.get(gameId)
    const game = activeGames.get(gameId)
    if (!game || removed.has(gameId)) throw Error('Game is no longer in the library.')
    return { game: enrich(game), warning: result.warning }
  }
  return {
    enrich,
    scan,
    rescrape,
    forget,
    cancelDisabledRequests,
    whenMediaIdle: () => Promise.all([mediaQueue, ...mediaTasks.values()])
  }
}
