import { isAbsolute, join, resolve } from 'node:path'

// Production callers must pass app.getPath('userData'); never derive a cache root
// from cwd, a ROM path, a renderer parameter, or a game's mediaDirectory property.
export function mediaRoot(userData) {
  if (typeof userData !== 'string' || !isAbsolute(userData)) {
    throw new Error('An absolute userData directory is required for media storage')
  }
  return join(resolve(userData), 'media')
}

export function gameMediaDirectory(userData, gameId) {
  if (typeof gameId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,150}$/.test(gameId)) {
    throw new Error('Invalid media game ID')
  }
  return join(mediaRoot(userData), gameId)
}
