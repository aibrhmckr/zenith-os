import fs from 'node:fs'
import { resolve, join, extname, basename, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { pathKey } from './platform.js'
import { CONSOLE_EXTENSIONS } from '../../shared/consoles.js'

const systems = new Map(
  Object.entries(CONSOLE_EXTENSIONS).flatMap(([system, exts]) => exts.map((ext) => [ext, system]))
)
export function createLibraryStore(userData) {
  const file = join(userData, 'library.json')
  let state = { imported: [], excluded: [] }
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (Array.isArray(data.imported) && Array.isArray(data.excluded)) state = data
  } catch {
    /* first run */
  }
  const save = () => {
    fs.mkdirSync(userData, { recursive: true })
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2))
    fs.renameSync(`${file}.tmp`, file)
  }
  const key = (value) => pathKey(resolve(value))
  const excluded = (value) => state.excluded.includes(key(value))
  const add = (paths) => {
    let count = 0
    for (const source of paths) {
      if (
        !systems.has(extname(source).toLowerCase()) ||
        !fs.statSync(source, { throwIfNoEntry: false })?.isFile()
      )
        continue
      const full = resolve(source)
      const existing = state.imported.some((value) => key(value) === key(full))
      state.excluded = state.excluded.filter((value) => value !== key(full))
      if (!existing) {
        state.imported.push(full)
        count++
      }
    }
    save()
    return count
  }
  const remove = (value) => {
    const normalized = key(value)
    state.imported = state.imported.filter((item) => key(item) !== normalized)
    if (!state.excluded.includes(normalized)) state.excluded.push(normalized)
    save()
  }
  const list = () =>
    state.imported
      .filter((file) => !excluded(file) && fs.statSync(file, { throwIfNoEntry: false })?.isFile())
      .map((file) => {
        const fileName = basename(file),
          ext = extname(file).toLowerCase()
        const systemShort =
          ext === '.iso' && /psp|vice city stories/i.test(file) ? 'PSP' : systems.get(ext)
        const importKey = createHash('sha256').update(key(file)).digest('hex').slice(0, 16)
        const stem = basename(file, extname(file))
        const cover =
          ['.jpg', '.png']
            .map((ext) => join(dirname(file), stem + ext))
            .find((p) => fs.existsSync(p)) || null
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
      })
  return { add, remove, list, excluded }
}
