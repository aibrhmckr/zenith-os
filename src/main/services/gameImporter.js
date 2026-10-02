import fs from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathKey } from './platform.js'
import { CONSOLE_EXTENSIONS } from '../../shared/consoles.js'
/**
 * Supported import extensions derived from the same registry used for scanning and file-picker
 * filters.
 */
const extensions = new Set(Object.values(CONSOLE_EXTENSIONS).flat())
/**
 * Create a serialized import queue targeting the central games directory. Returned importer
 * accepts source paths and resolves copied library paths without modifying originals.
 *
 * @param {string} gamesDirectory - Absolute central ROM directory; imported library copies are stored here.
 */
export function createGameImporter(gamesDirectory) {
  /**
   * Serial import barrier prevents two picker requests from racing while choosing numbered
   * destination names.
   */
  let queue = Promise.resolve()
  /**
   * Copy supported regular ROM files asynchronously, preserve PSP path hints, and choose
   * nonconflicting names. Publish a complete temporary copy and always remove staging.
   *
   * @param {string[]} sources - User-selected ROM paths copied without changing originals.
   */
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
  /**
   * Enqueue a source-path batch after the previous import; a rejected batch must not poison subsequent imports.
   *
   * @param {*} sources - Value supplied by the enclosing operation; interpreted in this callback's local scope.
   */
  return (sources) => {
    const result = queue.then(
      /**
       * Continue result after the preceding asynchronous stage resolves; the returned value or Promise feeds the same chain.
       */
      () => copy(sources)
    )
    queue = result.catch(
      /**
       * Handle the rejected stage of createGameImporter here so its failure follows this operation's fallback/error policy.
       */
      () => {}
    )
    return result
  }
}
