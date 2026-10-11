import fs from 'node:fs/promises'
import { join } from 'node:path'

/** Bounded asynchronous metadata scan; never reads file contents or follows symlinks. */
export function createFolderSummary({ maxEntries = 10000, timeBudgetMs = 2000 } = {}) {
  let revision = 0
  return {
    cancel() {
      revision++
    },
    async scan(path) {
      const generation = ++revision
      const deadline = Date.now() + timeBudgetMs
      const queue = [path]
      const result = { files: 0, folders: 0, size: 0, skipped: 0, partial: false }
      let visited = 0
      while (queue.length) {
        if (generation !== revision) return { canceled: true }
        if (visited >= maxEntries || Date.now() >= deadline) {
          result.partial = true
          break
        }
        const directory = queue.pop()
        try {
          const stat = await fs.lstat(directory)
          if (!stat.isDirectory() || stat.isSymbolicLink()) {
            result.skipped++
            continue
          }
          const handle = await fs.opendir(directory)
          for await (const entry of handle) {
            if (generation !== revision) return { canceled: true }
            if (visited >= maxEntries || Date.now() >= deadline) {
              result.partial = true
              break
            }
            visited++
            try {
              const child = join(directory, entry.name)
              const info = await fs.lstat(child)
              if (info.isSymbolicLink()) {
                result.skipped++
                continue
              }
              if (info.isDirectory()) {
                result.folders++
                queue.push(child)
              } else if (info.isFile()) {
                result.files++
                result.size += info.size
              } else result.skipped++
            } catch {
              result.skipped++
            }
          }
        } catch {
          result.skipped++
        }
        if (result.partial) break
      }
      if (generation !== revision) return { canceled: true }
      result.partial ||= result.skipped > 0
      return result
    }
  }
}
