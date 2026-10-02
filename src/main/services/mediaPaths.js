import { isAbsolute, join, resolve } from 'node:path'

// Production callers must pass app.getPath('userData'); never derive a cache root
// from cwd, a ROM path, a renderer parameter, or a game's mediaDirectory property.
/**
 * Require an absolute userData path and derive the only permitted root for downloaded game
 * media.
 *
 * @param {string} userData - Absolute Electron userData directory; owns caches and persistent runtime state.
 */
export function mediaRoot(userData) {
  if (typeof userData !== 'string' || !isAbsolute(userData)) {
    throw new Error('An absolute userData directory is required for media storage')
  }
  return join(resolve(userData), 'media')
}

/**
 * Validate a bounded game ID before resolving its cache directory; never trust a
 * renderer-provided destination.
 *
 * @param {string} userData - Absolute Electron userData directory; owns caches and persistent runtime state.
 * @param {string} gameId - Stable library/media identity; Main resolves or validates it before accessing files.
 */
export function gameMediaDirectory(userData, gameId) {
  if (typeof gameId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,150}$/.test(gameId)) {
    throw new Error('Invalid media game ID')
  }
  return join(mediaRoot(userData), gameId)
}
