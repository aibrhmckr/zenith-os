import fs from 'node:fs'
import { join } from 'node:path'
import { mediaRoot, gameMediaDirectory } from './mediaPaths.js'

/**
 * Default opt-in service switches; disabling a feature also hides cached content.
 */
export const DEFAULT_GUIDE_FEATURES = { manualsEnabled: true, loreEnabled: true }
/**
 * Trusted Archive origin for original manual discovery.
 */
const ARCHIVE = 'https://archive.org'
/**
 * Trusted English Wikipedia REST summary origin.
 */
const WIKI = 'https://en.wikipedia.org'
/**
 * One-day negative/cache freshness interval used by lore records.
 */
const DAY = 86400000
/**
 * Check for a cached regular file before requesting it again.
 *
 * @param {string} file - Local file path, except ranking callbacks where it is an Archive file metadata entry.
 */
const exists = (file) => fs.statSync(file, { throwIfNoEntry: false })?.isFile() === true
/**
 * Validate an Archive item identifier before embedding it in a request path.
 *
 * @param {*} id - Input used by this helper; see its operation contract above.
 */
const validId = (id) => typeof id === 'string' && /^[a-z\d][a-z\d._-]*$/i.test(id)
/**
 * Fold accents, case, and punctuation to compare game titles without choosing a different
 * sequel.
 *
 * @param {*} value - Input value being normalized, displayed, or committed by this helper.
 */
const normalized = (value) =>
  String(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '')
/**
 * Escape quotes and backslashes for an Archive advanced-search phrase.
 *
 * @param {*} value - Input value being normalized, displayed, or committed by this helper.
 */
const quote = (value) => `"${value.replace(/[\\"]/g, '\\$&')}"`
/**
 * Remove region tags and manual suffixes before exact normalized title comparison.
 *
 * @param {*} value - Input value being normalized, displayed, or committed by this helper.
 */
const manualTitle = (value) =>
  normalized(
    String(value)
      .replace(/\([^)]*\)|\[[^\]]*\]/g, '')
      .replace(/\s*[-:]?\s*(?:instruction\s+)?(?:manual|manual scans|instruction booklet)\s*$/i, '')
  )

/**
 * Allow only HTTPS Wikipedia summaries and supported Archive endpoints; validate every redirect
 * destination.
 *
 * @param {string|URL} url - Provider URL or parsed URL subject to the helper's origin/path policy.
 */
function allowed(url) {
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false
  if (url.origin === WIKI) return url.pathname.startsWith('/api/rest_v1/page/summary/')
  return (
    (url.hostname === 'archive.org' ||
      /^(?:ia|dn)\d+\.(?:[a-z]+\.)?archive\.org$/.test(url.hostname)) &&
    /^\/(advancedsearch\.php|metadata\/|download\/|BookReader\/|\d+\/items\/)/.test(url.pathname)
  )
}

// Every request has one deadline for redirects, headers and body. Never render remote HTML.
/**
 * Read a bounded guide response under one timeout covering redirects and body transfer. Always
 * abort and cancel readers when complete or failed.
 *
 * @param {string|URL} url - Provider URL or parsed URL subject to the helper's origin/path policy.
 * @param {Object} options2 - Named inputs for this operation.
 * @param {Function} options2.fetchImpl - Injectable fetch implementation; defaults to global fetch and enables offline tests.
 * @param {number} options2.timeoutMs - Single request deadline in milliseconds.
 * @param {number} limit - Maximum accepted response bytes.
 */
async function request(url, { fetchImpl, timeoutMs }, limit = 2 * 1024 * 1024) {
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
      if (!allowed(current)) throw Error('Unsupported guide URL')
      response = await fetchImpl(current.href, { signal: controller.signal, redirect: 'manual' })
      if (![301, 302, 303, 307, 308].includes(response.status)) break
      await response.body?.cancel()
      if (redirects === 4 || !response.headers.get('location')) throw Error('Redirect limit')
      current = new URL(response.headers.get('location'), current)
    }
    if (!response.ok || !response.body || Number(response.headers.get('content-length')) > limit) {
      await response.body?.cancel()
      throw Error('Guide unavailable')
    }
    reader = response.body.getReader()
    const chunks = []
    let size = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > limit) throw Error('Guide size limit')
      chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks)
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
 * Create userData-backed lore/manual caches with injectable networking and feature switches.
 * Shared pending tasks prevent duplicate writes and support deletion barriers.
 *
 * @param {Object} options - Named inputs for this operation.
 * @param {string} options.userData - Absolute Electron userData directory; owns caches and persistent runtime state.
 * @param {Function} options.fetchImpl - Injectable fetch implementation; defaults to global fetch and enables offline tests.
 * @param {number} options.timeoutMs - Single request deadline in milliseconds.
 * @param {Object} options.features - Optional manualsEnabled/loreEnabled boolean overrides.
 */
export function createGuideService({
  userData,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10000,
  features = {}
}) {
  mediaRoot(userData)
  /**
   * Mutable known feature switches; callers receive copies via getFeatures/setFeatures.
   */
  let flags = { ...DEFAULT_GUIDE_FEATURES, ...features }
  /**
   * Injected fetch and ten-second default deadline applied to every guide request.
   */
  const options = { fetchImpl, timeoutMs }
  /**
   * Coalesced lore/manual/page tasks; whenIdle exposes the deletion barrier.
   */
  const pending = new Map()
  /**
   * Parse a bounded guide response as JSON; invalid data propagates to the optional-content
   * fallback.
   *
   * @param {string|URL} url - Provider URL or parsed URL subject to the helper's origin/path policy.
   */
  const json = async (url) => JSON.parse((await request(url, options)).toString('utf8'))
  /**
   * Validate game identity/title and derive its cache via the shared userData confinement helper.
   *
   * @param {Object} game - Library game record, including identity, platform, and available local media.
   */
  const directory = (game) => {
    if (!game || !/^[a-z0-9][a-z0-9-]{0,150}$/.test(game.gameId) || typeof game.title !== 'string')
      throw Error('Unknown game')
    return gameMediaDirectory(userData, game.gameId)
  }
  /**
   * Share work by cache key, convert optional-content failures to null, and remove completed tasks
   * from the pending registry.
   *
   * @param {string|number} key - Action/cache/preference key or input code used by this operation.
   * @param {Function} task - Asynchronous work shared under a deduplication key.
   */
  function coalesce(key, task) {
    if (!pending.has(key))
      pending.set(
        key,
        Promise.resolve()
          .then(task)
          .catch(
            /**
             * Handle the rejected stage of coalesce here so its failure follows this operation's fallback/error policy.
             */
            () => null
          )
          .finally(
            /**
             * Release coalesce's pending-work bookkeeping after either success or failure.
             */
            () => pending.delete(key)
          )
      )
    return pending.get(key)
  }
  /**
   * Read cached JSON, treating a missing or damaged cache as a cache miss.
   *
   * @param {string} file - Local file path, except ranking callbacks where it is an Archive file metadata entry.
   */
  function read(file) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      return null
    }
  }
  /**
   * Atomically publish a serialized guide record through a temporary sibling file.
   *
   * @param {string} file - Local file path, except ranking callbacks where it is an Archive file metadata entry.
   * @param {*} value - Input value being normalized, displayed, or committed by this helper.
   */
  async function save(file, value) {
    await fs.promises.writeFile(`${file}.tmp`, JSON.stringify(value, null, 2))
    await fs.promises.rename(`${file}.tmp`, file)
  }
  /**
   * Find an exact Wikipedia game summary, extract only evidenced year/developer fields, and cache
   * it; disabled or unavailable lore returns null.
   *
   * @param {Object} game - Library game record, including identity, platform, and available local media.
   */
  async function getLore(game) {
    if (!flags.loreEnabled) return null
    return coalesce(
      `lore:${game?.gameId}` /**
       * Perform the shared getLore operation once per cache key; callers observe the same pending result.
       */,
      async () => {
        const dir = directory(game)
        const file = join(dir, 'lore.json')
        const cached = read(file)
        if (cached?.lore || Date.now() - cached?.checkedAt < DAY) return cached.lore
        // Disambiguate generic names such as Doom without choosing an unrelated article.
        for (const title of [game.title, `${game.title} (video game)`]) {
          try {
            const summary = await json(
              `${WIKI}/api/rest_v1/page/summary/${encodeURIComponent(title.replaceAll(' ', '_'))}`
            )
            if (summary.type === 'disambiguation' || typeof summary.extract !== 'string') continue
            if (
              !/\b(video game|game developed|platform game|shooter game|role-playing game)\b/i.test(
                `${summary.description || ''} ${summary.extract}`
              )
            )
              continue
            if (
              normalized(String(summary.title).replace(/\([^)]*\)/g, '')) !== normalized(game.title)
            )
              continue
            const intro = summary.extract.split('\n')[0].slice(0, 1400)
            const year =
              `${summary.description || ''} ${intro}`.match(/\b(?:19|20)\d{2}\b/)?.[0] || null
            const developer =
              intro
                .match(
                  /\bdeveloped by\s+(.+?)(?=\s+and published|\s+and released|\s+for the|\.|;|$)/i
                )?.[1]
                ?.trim() || null
            const lore = {
              summary: intro,
              year,
              developer,
              sourceTitle: 'Wikipedia (English)',
              sourceUrl: `${WIKI}/wiki/${encodeURIComponent((summary.titles?.canonical || title).replaceAll(' ', '_'))}`
            }
            if (!flags.loreEnabled) return null
            await fs.promises.mkdir(dir, { recursive: true })
            await save(file, { checkedAt: Date.now(), lore })
            return lore
          } catch {
            /* Try the explicit video-game title, then use the static empty state. */
          }
        }
        return null
      }
    )
  }
  /**
   * Find matching original manuals, exclude walkthroughs/restricted items, and cache up to 512
   * scan leaves for on-demand page requests.
   *
   * @param {Object} game - Library game record, including identity, platform, and available local media.
   */
  async function getManual(game) {
    if (!flags.manualsEnabled) return null
    return coalesce(
      `manual:${game?.gameId}` /**
       * Perform the shared getManual operation once per cache key; callers observe the same pending result.
       */,
      async () => {
        const dir = join(directory(game), 'manual')
        const file = join(dir, 'index.json')
        const cached = read(file)
        if (
          validId(cached?.identifier) &&
          Array.isArray(cached.leaves) &&
          cached.leaves.length &&
          cached.leaves.every(
            /**
             * Require every cached.leaves entry to satisfy getManual's invariant before continuing.
             *
             * @param {*} leaf - Value supplied by the enclosing operation; interpreted in this callback's local scope.
             */
            (leaf) => Number.isInteger(leaf) && leaf >= 0 && leaf < 10000
          )
        )
          return cached
        /**
         * Query Archive for matching original manual items; reject invalid identifiers and
         * strategy-guide results.
         *
         * @param {string} q - Escaped Archive advanced-search query.
         */
        const search = async (q) => {
          const params = new URLSearchParams({
            q,
            'fl[]': 'identifier,title,collection',
            rows: '8',
            output: 'json'
          })
          const result = await json(`${ARCHIVE}/advancedsearch.php?${params}`)
          return Array.isArray(result?.response?.docs)
            ? result.response.docs.filter(
                /**
                 * Retain only result.response.docs entries satisfying search's local predicate; excluded values do not reach the next stage.
                 *
                 * @param {*} doc - Value supplied by the enclosing operation; interpreted in this callback's local scope.
                 */
                (doc) =>
                  validId(doc?.identifier) &&
                  !/hint[_ -]*guide|strategy|walkthrough/i.test(
                    `${doc.title || ''} ${doc.identifier}`
                  ) &&
                  manualTitle(doc.title || game.title) === normalized(game.title)
              )
            : []
        }
        let docs = await search(`collection:(videogamemanuals) AND title:(${quote(game.title)})`)
        if (!docs.length)
          docs = await search(
            `(collection:manuals OR collection:consolemanuals) AND title:(${quote(game.title)})`
          )
        const platform = normalized(game.systemShort)
        /**
         * Rank otherwise matching manuals by platform and region before inspecting their scan metadata.
         *
         * @param {Object} doc - Archive search result being ranked.
         */
        const score = (doc) =>
          (normalized(`${doc.identifier} ${doc.collection || ''}`).includes(platform) ? 4 : 0) +
          (game.region && doc.title?.toLowerCase().includes(game.region.toLowerCase()) ? 1 : 0)
        docs.sort(
          /**
           * Order docs candidates deterministically before getManual consumes the preferred result.
           *
           * @param {*} a - Value supplied by the enclosing operation; interpreted in this callback's local scope.
           * @param {*} b - Value supplied by the enclosing operation; interpreted in this callback's local scope.
           */
          (a, b) => score(b) - score(a)
        )
        for (const doc of docs.slice(0, 3)) {
          try {
            const metadata = await json(`${ARCHIVE}/metadata/${encodeURIComponent(doc.identifier)}`)
            if (
              metadata.is_dark ||
              ['true', true, '1', 1].includes(metadata.metadata?.['access-restricted-item'])
            )
              continue
            const scan = metadata.files?.find(
              /**
               * Select the first matching metadata.files entry for scan; absence is handled by the caller's fallback.
               *
               * @param {*} entry - Value supplied by the enclosing operation; interpreted in this callback's local scope.
               */
              (entry) => /_scandata\.xml$/i.test(entry.name) && !entry.private
            )
            if (!scan || scan.name.includes('/') || scan.name.includes('\\')) continue
            const xml = (
              await request(
                `${ARCHIVE}/download/${encodeURIComponent(doc.identifier)}/${encodeURIComponent(scan.name)}`,
                options
              )
            ).toString('utf8')
            const leaves = [
              ...xml.matchAll(/<page\b[^>]*\bleafNum=["'](\d+)["'][^>]*>([\s\S]*?)<\/page>/gi)
            ]
              .filter(
                /**
                 * Retain only [ ...xml.matchAll(/<page\b[^>]*\bleafNum=["'](\d+)["'][^>]*>([\s\S]*?)<\/page>/gi) ] entries satisfying leaves's local predicate; excluded values do not reach the next stage.
                 *
                 * @param {*} match - Value supplied by the enclosing operation; interpreted in this callback's local scope.
                 */
                (match) => !/<addToAccessFormats>\s*false\s*<\/addToAccessFormats>/i.test(match[2])
              )
              .map(
                /**
                 * Project each [ ...xml.matchAll(/<page\b[^>]*\bleafNum=["'](\d+)["'][^>]*>([\s\S]*?)<\/page>/gi) ] .filter( ( entry for leaves; preserve input ordering in the derived collection.
                 *
                 * @param {*} match - Value supplied by the enclosing operation; interpreted in this callback's local scope.
                 */
                (match) => Number(match[1])
              )
              .filter(
                /**
                 * Retain only [ ...xml.matchAll(/<page\b[^>]*\bleafNum=["'](\d+)["'][^>]*>([\s\S]*?)<\/page>/gi) ] .filter( ( entries satisfying leaves's local predicate; excluded values do not reach the next stage.
                 *
                 * @param {*} leaf - Value supplied by the enclosing operation; interpreted in this callback's local scope.
                 */
                (leaf) => leaf >= 0 && leaf < 10000
              )
              .slice(0, 512)
            if (!leaves.length || !flags.manualsEnabled) continue
            const manual = {
              identifier: doc.identifier,
              title: doc.title || game.title,
              leaves: [...new Set(leaves)],
              sourceUrl: `${ARCHIVE}/details/${encodeURIComponent(doc.identifier)}`
            }
            await fs.promises.mkdir(dir, { recursive: true })
            await save(file, manual)
            return manual
          } catch {
            /* A missing scan should not prevent another matching manual. */
          }
        }
        return null
      }
    )
  }
  /**
   * Validate the page index and cache a bounded JPEG for the requested scan leaf; feature
   * disabling and failures leave a null empty state.
   *
   * @param {Object} game - Library game record, including identity, platform, and available local media.
   * @param {number} index - Zero-based selection, button, or page index.
   */
  async function getPage(game, index) {
    if (!flags.manualsEnabled || !Number.isInteger(index) || index < 0 || index >= 512) return null
    return coalesce(
      `page:${game?.gameId}:${index}` /**
       * Perform the shared getPage operation once per cache key; callers observe the same pending result.
       */,
      async () => {
        const manual = await getManual(game)
        if (!flags.manualsEnabled || !manual || index >= manual.leaves.length) return null
        const dir = join(directory(game), 'manual')
        const file = join(dir, `${manual.identifier}-page-${manual.leaves[index]}.jpg`)
        if (exists(file)) return file
        const bytes = await request(
          `${ARCHIVE}/download/${encodeURIComponent(manual.identifier)}/page/n${manual.leaves[index]}.jpg`,
          options,
          8 * 1024 * 1024
        )
        if (
          bytes.length < 4 ||
          !bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ||
          !flags.manualsEnabled
        )
          return null
        try {
          await fs.promises.writeFile(`${file}.tmp`, bytes)
          await fs.promises.rename(`${file}.tmp`, file)
        } finally {
          await fs.promises.rm(`${file}.tmp`, { force: true }).catch(
            /**
             * Handle the rejected stage of getPage here so its failure follows this operation's fallback/error policy.
             */
            () => {}
          )
        }
        return file
      }
    )
  }
  return {
    /**
     * Wait for the currently tracked guide tasks before game deletion removes their destination
     * directory.
     */
    whenIdle: () => Promise.allSettled([...pending.values()]),
    getLore,
    getManual,
    getPage,
    /**
     * Return a copy of feature switches so consumers cannot mutate internal service state.
     */
    getFeatures: () => ({ ...flags }),
    /**
     * Apply known boolean feature switches only; disabled features skip both network requests and
     * cached display.
     *
     * @param {Object} next - New feature values; unknown or nonboolean flags are ignored.
     */
    setFeatures: (next) => {
      for (const key of Object.keys(DEFAULT_GUIDE_FEATURES))
        if (typeof next?.[key] === 'boolean') flags[key] = next[key]
      return { ...flags }
    }
  }
}
