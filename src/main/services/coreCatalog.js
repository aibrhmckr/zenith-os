import fs from 'node:fs'
import { join } from 'node:path'
import { buildbotBase, CORE_FILES, installedCorePath } from './coreManager.js'

/**
 * Human-readable core aliases used by alphabetical browsing and search.
 */
const LABELS = {
  stella: 'Stella · Atari 2600',
  prosystem: 'ProSystem · Atari 7800',
  mednafen_lynx: 'Beetle Lynx · Atari Lynx',
  gearlynx: 'Gearlynx · Atari Lynx',
  atari800: 'Atari800 · Atari 800 / 5200',
  a5200: 'Atari 5200',
  mesen: 'Mesen · NES',
  desmume: 'DeSmuME · Nintendo DS',
  pcsx2: 'PCSX2 · PlayStation 2',
  lrps2: 'LRPS2 · PlayStation 2'
}
/**
 * Combine the official host catalog with verified local cores and persist per-game/platform
 * selections in userData.
 *
 * @param {Object} options - Named inputs for this operation.
 * @param {string} options.retroarchDir - Active writable RetroArch runtime directory shared by install, status, and launch.
 * @param {string} options.userData - Absolute Electron userData directory; owns caches and persistent runtime state.
 * @param {string} options.platform - Platform selector; OS helpers accept win32/linux, BIOS and IPC helpers accept a library console ID.
 * @param {Function} options.fetchImpl - Injectable fetch implementation; defaults to global fetch and enables offline tests.
 */
export function createCoreCatalog({
  retroarchDir,
  userData,
  platform = process.platform,
  fetchImpl = globalThis.fetch
}) {
  /**
   * Host-native core extension; Linux catalogs must not offer Windows binaries.
   */
  const suffix = platform === 'linux' ? '.so' : '.dll'
  /**
   * Reject paths and mismatched extensions before a catalog filename can become an installation
   * target.
   *
   * @param {string} name - Filename or named action selected by the caller; accepted values are validated by this helper.
   */
  const valid = (name) =>
    typeof name === 'string' &&
    /^[a-z0-9_-]+_libretro\.(dll|so)$/i.test(name) &&
    name.endsWith(suffix)
  /**
   * Host-specific userData catalog cache used when Buildbot is unavailable.
   */
  const cacheFile = join(userData, 'core-catalog-' + platform + '.json')
  /**
   * Persistent game:/platform: core overrides, independent of library and media manifests.
   */
  const selectionsFile = join(userData, 'core-selections.json')
  /**
   * Catalog names, persisted selections, one pending request, and last successful fetch time form
   * the catalog cache state.
   */
  let names = [],
    selections = {},
    pending,
    loadedAt = 0
  try {
    names = JSON.parse(fs.readFileSync(cacheFile, 'utf8')).filter(valid)
  } catch {
    /* first run */
  }
  try {
    selections = JSON.parse(fs.readFileSync(selectionsFile, 'utf8')) || {}
  } catch {
    /* first run */
  }
  /**
   * Enumerate only regular local core files that pass the shared native-header validator;
   * inaccessible directories produce an empty list.
   */
  const installed = () => {
    try {
      return fs
        .readdirSync(join(retroarchDir, 'cores'), { withFileTypes: true })
        .filter(
          /**
           * Retain only fs .readdirSync(join(retroarchDir, 'cores'), { withFileTypes: true }) entries satisfying installed's local predicate; excluded values do not reach the next stage.
           *
           * @param {*} f - Value supplied by the enclosing operation; interpreted in this callback's local scope.
           */
          (f) => f.isFile() && valid(f.name) && installedCorePath(retroarchDir, f.name, platform)
        )
        .map(
          /**
           * Project each fs .readdirSync(join(retroarchDir, 'cores'), { withFileTypes: true }) .filter( (f) => f.isFile( entry for installed; preserve input ordering in the derived collection.
           *
           * @param {*} f - Value supplied by the enclosing operation; interpreted in this callback's local scope.
           */
          (f) => f.name
        )
    } catch {
      return []
    }
  }
  /**
   * Merge remote names and verified installations, add searchable labels, and sort
   * deterministically for the core browser.
   */
  const entries = () => {
    const local = new Set(installed())
    return [...new Set([...names, ...local])]
      .map(
        /**
         * Project each [...new Set([...names, ...local])] entry for entries; preserve input ordering in the derived collection.
         *
         * @param {*} fileName - Value supplied by the enclosing operation; interpreted in this callback's local scope.
         */
        (fileName) => {
          const stem = fileName.replace(/_libretro\.(dll|so)$/, '')
          return {
            fileName,
            name: LABELS[stem] || stem.replaceAll('_', ' '),
            installed: local.has(fileName)
          }
        }
      )
      .sort(
        /**
         * Order [...new Set([...names, ...local])] .map((fileName) => { const stem = fileName.replace(/_libretr candidates deterministically before entries consumes the preferred result.
         *
         * @param {*} a - Value supplied by the enclosing operation; interpreted in this callback's local scope.
         * @param {*} b - Value supplied by the enclosing operation; interpreted in this callback's local scope.
         */
        (a, b) => a.name.localeCompare(b.name) || a.fileName.localeCompare(b.fileName)
      )
  }
  /**
   * Coalesce catalog requests with a one-hour memory cache and disk fallback. Enforce the official
   * origin, a ten-second deadline, and a two-MiB response limit.
   */
  const list = () => {
    if (loadedAt && Date.now() - loadedAt < 3600000)
      return Promise.resolve({ success: true, cores: entries(), offline: false })
    if (pending) return pending
    pending = (
      /**
       * Complete the enclosing callback step owned by list; caller arguments and captured state determine this stage's result.
       */
      async () => {
        try {
          if (!['win32', 'linux'].includes(platform)) throw Error('Unsupported host platform.')
          const response = await fetchImpl(buildbotBase(platform), {
            signal: AbortSignal.timeout(10000),
            redirect: 'error'
          })
          if (!response.ok || !response.body) throw Error('Core catalog unavailable.')
          const chunks = []
          let size = 0
          for await (const chunk of response.body) {
            size += chunk.length
            if (size > 2 * 1024 * 1024) throw Error('Core catalog too large.')
            chunks.push(Buffer.from(chunk))
          }
          const html = Buffer.concat(chunks).toString('utf8')
          const found = [...html.matchAll(/href=["']([^"']+)["']/gi)].flatMap(
            /**
             * Expand [...html.matchAll(/href=["']([^"']+)["']/gi)] entries for found, flattening each result into the shared lookup/list.
             *
             * @param {*} input1 - Value supplied by the enclosing operation; interpreted in this callback's local scope.
             */
            ([, href]) => {
              try {
                const url = new URL(href, buildbotBase(platform)),
                  base = new URL(buildbotBase(platform))
                if (
                  url.origin !== base.origin ||
                  !url.pathname.startsWith(base.pathname) ||
                  url.search
                )
                  return []
                const name = decodeURIComponent(url.pathname.slice(base.pathname.length)).replace(
                  /\.zip$/,
                  ''
                )
                return url.pathname.endsWith('.zip') && valid(name) ? [name] : []
              } catch {
                return []
              }
            }
          )
          if (!found.length) throw Error('Core catalog is empty.')
          names = [...new Set(found)]
          loadedAt = Date.now()
          await fs.promises.mkdir(userData, { recursive: true })
          await fs.promises.writeFile(cacheFile, JSON.stringify(names))
          return { success: true, cores: entries(), offline: false }
        } catch (error) {
          return {
            success: entries().length > 0,
            cores: entries(),
            offline: true,
            error: error.message
          }
        }
      }
    )().finally(
      /**
       * Release list's pending-work bookkeeping after either success or failure.
       */
      () => {
        pending = null
      }
    )
    return pending
  }
  /**
   * Check a syntactically valid name against the combined trusted catalog before honoring a
   * renderer selection.
   *
   * @param {string} name - Filename or named action selected by the caller; accepted values are validated by this helper.
   */
  const allowed = async (name) =>
    valid(name) &&
    (await list()).cores.some(
      /**
       * Short-circuit when any (await list()).cores entry meets allowed's condition.
       *
       * @param {*} core - Value supplied by the enclosing operation; interpreted in this callback's local scope.
       */
      (core) => core.fileName === name
    )
  /**
   * Prefer a game override to a platform override, but return it only while the selected core is
   * physically valid.
   *
   * @param {string} gameId - Stable library/media identity; Main resolves or validates it before accessing files.
   * @param {string} system - Console ID from the shared platform registry.
   */
  const get = (gameId, system) => {
    const name = selections['game:' + gameId] || selections['platform:' + system]
    return valid(name) && installedCorePath(retroarchDir, name, platform) ? name : null
  }
  /**
   * Persist core selections below userData so subsequent sessions use the chosen core.
   */
  const save = async () => {
    await fs.promises.mkdir(userData, { recursive: true })
    await fs.promises.writeFile(selectionsFile, JSON.stringify(selections, null, 2))
  }
  /**
   * Record a validated game/platform selection and await persistence; callers first install and
   * verify the core.
   *
   * @param {string|number} key - Action/cache/preference key or input code used by this operation.
   * @param {string} name - Filename or named action selected by the caller; accepted values are validated by this helper.
   */
  const select = async (key, name) => {
    if (!valid(name)) throw Error('Invalid core.')
    selections[key] = name
    await save()
  }
  /**
   * Remove only the deleted game's core override and persist the remaining selections.
   *
   * @param {string} gameId - Stable library/media identity; Main resolves or validates it before accessing files.
   */
  const forget = async (gameId) => {
    delete selections['game:' + gameId]
    await save()
  }
  return { list, allowed, get, select, forget }
}

/**
 * Recognize BIOS-gated core families by DLL/SO stem so a manual selection cannot bypass required
 * BIOS checks.
 *
 * @param {string} fileName - Filename used for platform detection, catalog matching, or core-family lookup.
 * @param {string} fallback - Detected console used when the chosen core has no recognized BIOS family.
 */
export function biosPlatformForCore(fileName, fallback) {
  for (const system of ['PS2', 'PS1', 'Dreamcast'])
    if (
      CORE_FILES[system].some(
        /**
         * Short-circuit when any CORE_FILES[system] entry meets biosPlatformForCore's condition.
         *
         * @param {*} name - Value supplied by the enclosing operation; interpreted in this callback's local scope.
         */
        (name) => name.replace(/\.dll$/, '') === fileName.replace(/\.(dll|so)$/, '')
      )
    )
      return system
  return fallback
}
