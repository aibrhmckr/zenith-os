import fs from 'node:fs'
import { join } from 'node:path'

export { MEDIA_DEFAULTS, mediaPreferences } from '../../shared/mediaPreferences.js'
/** Serialize atomic patches so hotkey and media updates cannot erase one another. */
export function createPreferences(userData) {
  const file = join(userData, 'zenith-preferences.json')
  let saved = {}
  try {
    saved = JSON.parse(fs.readFileSync(file, 'utf8')) || {}
  } catch {
    /* Defaults. */
  }
  let queue = Promise.resolve()
  return {
    get: () => saved,
    update(patch) {
      const task = queue
        .catch(() => {})
        .then(async () => {
          const next = { ...saved, ...(typeof patch === 'function' ? patch(saved) : patch) }
          await fs.promises.mkdir(userData, { recursive: true })
          await fs.promises.writeFile(file + '.tmp', JSON.stringify(next, null, 2))
          await fs.promises.rename(file + '.tmp', file)
          saved = next
          return next
        })
      queue = task
      return task
    }
  }
}
