import fs from 'node:fs'
import { join, parse, extname } from 'node:path'
import { createHash } from 'node:crypto'
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
const NAMES = { boxart: 'boxart.png', snap: 'snap.png', titleScreen: 'title.png' }
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
    cleanGameName(game.fileName)
      .title.normalize('NFKD')
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
const exists = (file) => fs.statSync(file, { throwIfNoEntry: false })?.isFile() === true

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
  /**
   * Deletion tombstones checked before and after network work to prevent cache resurrection.
   */
  const removed = new Set()
  /**
   * Per-game active preview tasks that deletion must await.
   */
  const runningMedia = new Map()
  const downloadMedia = createMediaDownloader({ userData, fetchImpl, timeoutMs: mediaTimeoutMs })

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
      title: game.title,
      platform: game.systemShort,
      region: game.region,
      year: null,
      developer: null,
      genre: null,
      ...previous,
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
  function queueMedia(games, force) {
    if (force) downloadMedia.clearCatalogs()
    for (const original of games) {
      const game = enrich(original)
      removed.delete(game.gameId)
      if (pendingMedia.has(game.gameId)) continue
      const kinds = ['music', 'video'].filter(
        /**
         * Retain only ['music', 'video'] entries satisfying kinds's local predicate; excluded values do not reach the next stage.
         *
         * @param {*} kind - Value supplied by the enclosing operation; interpreted in this callback's local scope.
         */
        (kind) =>
          !game.media[kind] &&
          (force || Date.now() - (records[game.gameId]?.archiveCheckedAt?.[kind] || 0) >= DAY)
      )
      if (!kinds.length) continue
      pendingMedia.add(game.gameId)
      // One game at a time; its audio/video requests are independent of artwork and each other.
      mediaQueue = mediaQueue
        .then(
          /**
           * Continue queueMedia after the preceding asynchronous stage resolves; the returned value or Promise feeds the same chain.
           */
          async () => {
            if (!activeGames.has(game.gameId) || removed.has(game.gameId)) return
            const task = downloadMedia(enrich(game), {
              kinds,
              /**
               * Merge a completed media lookup into the manifest and notify only if the game still exists and
               * a usable file was downloaded.
               *
               * @param {string} kind - Media category or modal type selecting this operation's behavior.
               * @param {*} path - Input used by this helper; see its operation contract above.
               */
              onResult: async (kind, path) => {
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
                      archiveCheckedAt: { ...previous?.archiveCheckedAt, [kind]: Date.now() }
                    })
                  }
                )
                if (path && updated && activeGames.has(game.gameId)) onMediaUpdated(updated)
              }
            })
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
          () => pendingMedia.delete(game.gameId)
        )
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
    const metadata = cleanGameName(game.fileName)
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
    for (const [kind, folder, suffix, cachedName] of [
      ['music', 'music', 'mp3', 'theme.mp3'],
      ['video', 'videos', 'mp4', 'preview.mp4']
    ]) {
      media[kind] =
        [join(directory, cachedName), join(mediaRoot, folder, `${gameId}.${suffix}`)].find(
          exists
        ) || null
    }
    return { ...game, ...metadata, gameId, media, mediaDirectory: directory }
  }

  /**
   * Fetch a bounded Libretro response with an eight-second timeout; 404 is a cache miss and other
   * failures stop online artwork work.
   *
   * @param {string|URL} url - Provider URL or parsed URL subject to the helper's origin/path policy.
   * @param {number} limit - Maximum accepted response bytes.
   */
  async function request(url, limit) {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(8000), redirect: 'error' })
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
            const html = (await request(base, 8 * 1024 * 1024))?.toString('utf8') || ''
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
    { force = false } = {}
  ) {
    if (inFlight) return inFlight
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
        queueMedia(games, force)
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
            const previous = records[game.gameId]
            let checkedAt = previous?.checkedAt || 0
            if (!offline && (force || Date.now() - checkedAt > DAY)) {
              try {
                const system =
                  extname(game.fileName).toLowerCase() === '.gb'
                    ? 'Nintendo - Game Boy'
                    : SYSTEMS[game.systemShort]
                if (system) {
                  for (const kind of Object.keys(KINDS)) {
                    if (removed.has(game.gameId)) break
                    if (game.media[kind] || offline) continue
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
                    if (!candidates.length) continue
                    const bytes = await request(candidates[0].url, 20 * 1024 * 1024)
                    if (removed.has(game.gameId)) break
                    if (!bytes) continue
                    if (!bytes.subarray(0, 8).equals(PNG)) throw new Error('Geçersiz PNG yanıtı')
                    await fs.promises.mkdir(game.mediaDirectory, { recursive: true })
                    const target = join(game.mediaDirectory, NAMES[kind])
                    await fs.promises.writeFile(`${target}.tmp`, bytes)
                    await fs.promises.rename(`${target}.tmp`, target)
                  }
                }
                if (!offline) checkedAt = Date.now()
              } catch (error) {
                offline = true
                warning = `Medya indirilemedi; yerel önbellek kullanılıyor. ${error.message}`
              }
            }
            game = enrich(game)
            if (removed.has(game.gameId)) continue
            nextRecords[game.gameId] = recordFor(game, { checkedAt })
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
  return { enrich, scan, forget, whenMediaIdle: () => mediaQueue }
}
