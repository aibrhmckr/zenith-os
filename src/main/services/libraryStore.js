import fs from 'node:fs'
import { resolve, join, extname, basename, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { pathKey } from './platform.js'
import { CONSOLE_EXTENSIONS } from '../../shared/consoles.js'

/**
 * Reverse extension lookup for imported ROMs, sharing the scanner platform registry.
 */
const systems = new Map(
  Object.entries(CONSOLE_EXTENSIONS).flatMap(
    /**
     * Expand Object.entries(CONSOLE_EXTENSIONS) entries for systems, flattening each result into the shared lookup/list.
     *
     * @param {*} input1 - Value supplied by the enclosing operation; interpreted in this callback's local scope.
     */
    ([system, exts]) =>
      exts.map(
        /**
         * Project each exts entry for systems; preserve input ordering in the derived collection.
         *
         * @param {*} ext - Value supplied by the enclosing operation; interpreted in this callback's local scope.
         */
        (ext) => [ext, system]
      )
  )
)
/**
 * Load the imported/excluded path registry from library.json. Keep this registry separate from
 * the scraper's games.json media manifest.
 *
 * @param {string} userData - Absolute Electron userData directory; owns caches and persistent runtime state.
 */
export function createLibraryStore(userData) {
  /**
   * User-owned import/exclusion manifest; media metadata is stored separately in games.json.
   */
  const file = join(userData, 'library.json')
  /**
   * Imported absolute paths and excluded normalized paths loaded once and persisted together.
   */
  let state = { imported: [], excluded: [] }
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (Array.isArray(data.imported) && Array.isArray(data.excluded)) state = data
  } catch {
    /* first run */
  }
  /**
   * Write a temporary JSON snapshot and rename it into place so readers do not see partially
   * written registry data.
   */
  const save = () => {
    fs.mkdirSync(userData, { recursive: true })
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2))
    fs.renameSync(`${file}.tmp`, file)
  }
  /**
   * Canonicalize an absolute path using host case rules for deduplication and exclusion checks.
   *
   * @param {*} value - Input value being normalized, displayed, or committed by this helper.
   */
  const key = (value) => pathKey(resolve(value))
  /**
   * Check whether the normalized ROM path was removed from the library.
   *
   * @param {*} value - Input value being normalized, displayed, or committed by this helper.
   */
  const excluded = (value) => state.excluded.includes(key(value))
  /**
   * Accept existing supported ROM paths, clear their exclusion entries, deduplicate imports, and
   * persist; return the new-entry count.
   *
   * @param {string[]} paths - Absolute ROM paths to register.
   */
  const add = (paths) => {
    let count = 0
    for (const source of paths) {
      if (
        !systems.has(extname(source).toLowerCase()) ||
        !fs.statSync(source, { throwIfNoEntry: false })?.isFile()
      )
        continue
      const full = resolve(source)
      const existing = state.imported.some(
        /**
         * Short-circuit when any state.imported entry meets existing's condition.
         *
         * @param {*} value - Value supplied by the enclosing operation; interpreted in this callback's local scope.
         */
        (value) => key(value) === key(full)
      )
      state.excluded = state.excluded.filter(
        /**
         * Retain only state.excluded entries satisfying add's local predicate; excluded values do not reach the next stage.
         *
         * @param {*} value - Value supplied by the enclosing operation; interpreted in this callback's local scope.
         */
        (value) => value !== key(full)
      )
      if (!existing) {
        state.imported.push(full)
        count++
      }
    }
    save()
    return count
  }
  /**
   * Remove an imported path and record its exclusion; physical ROM/cache deletion is owned by the
   * main IPC handler.
   *
   * @param {*} value - Input value being normalized, displayed, or committed by this helper.
   */
  const remove = (value) => {
    const normalized = key(value)
    state.imported = state.imported.filter(
      /**
       * Retain only state.imported entries satisfying remove's local predicate; excluded values do not reach the next stage.
       *
       * @param {*} item - Value supplied by the enclosing operation; interpreted in this callback's local scope.
       */
      (item) => key(item) !== normalized
    )
    if (!state.excluded.includes(normalized)) state.excluded.push(normalized)
    save()
  }
  /**
   * Reconstruct game records for existing, nonexcluded imports with deterministic IDs, platform
   * detection, and adjacent artwork.
   */
  const list = () =>
    state.imported
      .filter(
        /**
         * Retain only state.imported entries satisfying list's local predicate; excluded values do not reach the next stage.
         *
         * @param {*} file - Value supplied by the enclosing operation; interpreted in this callback's local scope.
         */
        (file) => !excluded(file) && fs.statSync(file, { throwIfNoEntry: false })?.isFile()
      )
      .map(
        /**
         * Project each state.imported .filter((file) => !excluded(file) && fs.statSync(file, { throwIfNoEntry: false } entry for list; preserve input ordering in the derived collection.
         *
         * @param {*} file - Value supplied by the enclosing operation; interpreted in this callback's local scope.
         */
        (file) => {
          const fileName = basename(file),
            ext = extname(file).toLowerCase()
          const systemShort =
            ext === '.iso' && /psp|vice city stories/i.test(file) ? 'PSP' : systems.get(ext)
          const importKey = createHash('sha256').update(key(file)).digest('hex').slice(0, 16)
          const stem = basename(file, extname(file))
          const cover =
            ['.jpg', '.png']
              .map(
                /**
                 * Project each ['.jpg', '.png'] entry for cover; preserve input ordering in the derived collection.
                 *
                 * @param {*} ext - Value supplied by the enclosing operation; interpreted in this callback's local scope.
                 */
                (ext) => join(dirname(file), stem + ext)
              )
              .find(
                /**
                 * Select the first matching ['.jpg', '.png'] .map((ext) => join(dirname(file), stem + ext)) entry for cover; absence is handled by the caller's fallback.
                 *
                 * @param {*} p - Value supplied by the enclosing operation; interpreted in this callback's local scope.
                 */
                (p) => fs.existsSync(p)
              ) || null
          return {
            id: `import-${importKey}`,
            importKey,
            fileName,
            title: stem,
            path: file,
            system: systemShort,
            systemShort,
            cover,
            backdrop: cover,
            imported: true
          }
        }
      )
  return { add, remove, list, excluded }
}
