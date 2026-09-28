import fs from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathKey } from './platform.js'
import { CONSOLE_EXTENSIONS } from '../../shared/consoles.js'
const extensions = new Set(Object.values(CONSOLE_EXTENSIONS).flat())
export function createGameImporter(gamesDirectory) {
  let queue = Promise.resolve()
  const copy = async (sources) => {
    await fs.promises.mkdir(gamesDirectory, { recursive: true })
    const imported = []
    for (const source of sources) {
      if (
        !extensions.has(extname(source).toLowerCase()) ||
        !(await fs.promises.stat(source)).isFile()
      )
        continue
      if (pathKey(dirname(resolve(source))) === pathKey(resolve(gamesDirectory))) {
        imported.push(resolve(source))
        continue
      }
      const temporary = join(gamesDirectory, '.import-' + randomUUID() + '.part')
      try {
        await fs.promises.copyFile(source, temporary, fs.constants.COPYFILE_EXCL)
        const extension = extname(source)
        let stem = basename(source, extension)
        if (
          extension.toLowerCase() === '.iso' &&
          /psp|vice city stories/i.test(source) &&
          !/psp|vice city stories/i.test(stem)
        )
          stem += ' (PSP)'
        for (let n = 0; ; n++) {
          const destination = join(gamesDirectory, stem + (n ? ' (' + n + ')' : '') + extension)
          try {
            // Publish only complete copies, without ever replacing an existing game.
            await fs.promises.link(temporary, destination)
            imported.push(destination)
            break
          } catch (error) {
            if (error.code === 'EEXIST') continue
            if (!['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV'].includes(error.code)) throw error
            try {
              await fs.promises.copyFile(temporary, destination, fs.constants.COPYFILE_EXCL)
              imported.push(destination)
              break
            } catch (error) {
              if (error.code !== 'EEXIST') throw error
            }
          }
        }
      } finally {
        await fs.promises.rm(temporary, { force: true })
      }
    }
    return imported
  }
  return (sources) => {
    const result = queue.then(() => copy(sources))
    queue = result.catch(() => {})
    return result
  }
}
