/**
 * Own the release lifecycle independently of expiring download notifications.
 * `publish(channel, state)` sends a serializable snapshot to the isolated renderer.
 * Production downloads are staged automatically, then installed on explicit restart or normal quit.
 */
export function createApplicationUpdater({
  updater,
  downloads,
  enabled,
  app = { isPackaged: true },
  canInstall = () => true,
  publish = () => {}
}) {
  let pending = null
  let state = { status: app.isPackaged ? 'idle' : 'developer', ready: false }
  const report = (value) =>
    downloads.report({ id: 'zenith-update', name: 'Zenith OS', kind: 'app', ...value })
  const emit = (event, value) => {
    state = { ...state, ...value }
    publish('app-update:' + event, { ...state })
  }
  const failure = (error) => {
    const message = error?.message || String(error)
    // electron-updater can emit an error and reject the same check/download promise.
    if (state.status !== 'error' || state.message !== message) {
      emit('error', { status: 'error', message })
      report({ status: 'failed', error: message })
    }
    return { success: false, error: message }
  }
  updater.autoDownload = Boolean(app.isPackaged && enabled)
  updater.autoInstallOnAppQuit = Boolean(app.isPackaged && enabled)
  updater.allowPrerelease = false
  updater.allowDowngrade = false
  updater.disableDifferentialDownload = false
  updater.on('checking-for-update', () => {
    emit('checking', {
      status: 'checking',
      ready: false,
      version: null,
      percent: null,
      message: null
    })
    report({ status: 'active', phase: 'checking', percent: null, error: null })
  })
  updater.on('update-available', (info) => {
    emit('available', {
      status: 'downloading',
      ready: false,
      version: info.version,
      releaseDate: info.releaseDate,
      releaseNotes: info.releaseNotes,
      percent: 0,
      message: null
    })
    report({ status: 'active', phase: 'downloading', version: info.version, percent: 0 })
  })
  updater.on('update-not-available', () => {
    emit('not-available', { status: 'up-to-date', ready: false, percent: null, message: null })
    report({ status: 'completed', phase: 'up-to-date' })
  })
  updater.on('download-progress', (value) => {
    emit('progress', {
      status: 'downloading',
      percent: value.percent,
      bytesPerSecond: value.bytesPerSecond,
      transferred: value.transferred,
      total: value.total
    })
    report({
      status: 'active',
      phase: 'downloading',
      received: value.transferred,
      total: value.total,
      percent: value.percent
    })
  })
  updater.on('update-downloaded', (info) => {
    emit('downloaded', {
      status: 'downloaded',
      ready: true,
      version: info.version,
      percent: 100,
      message: null
    })
    report({ status: 'completed', phase: 'ready-to-install', version: info.version })
  })
  updater.on('error', failure)
  return {
    snapshot: () => ({ ...state }),
    check() {
      if (!app.isPackaged)
        return Promise.resolve({ success: true, upToDate: true, developer: true })
      if (!enabled)
        return Promise.resolve({ success: false, error: 'Updates require an installed release.' })
      if (pending) return pending
      if (state.ready) return Promise.resolve({ success: true, ready: true })
      // Defer the provider call so even synchronous failures release the pending lease correctly.
      pending = Promise.resolve()
        .then(async () => {
          try {
            const result = await updater.checkForUpdates()
            await result?.downloadPromise
            if (state.status === 'error') return { success: false, error: state.message }
            return { success: true, ready: state.ready }
          } catch (error) {
            return failure(error)
          }
        })
        .finally(() => {
          pending = null
        })
      return pending
    },
    install(confirmed) {
      if (
        !app.isPackaged ||
        !enabled ||
        !state.ready ||
        pending ||
        confirmed !== true ||
        !canInstall()
      )
        return {
          success: false,
          error: 'Stop the game and running setup before installing a ready update.'
        }
      try {
        // An install failure may be emitted synchronously instead of being thrown.
        state = { ...state, status: 'downloaded', message: null }
        updater.quitAndInstall(false, true)
        return state.status === 'error'
          ? { success: false, error: state.message }
          : { success: true }
      } catch (error) {
        return failure(error)
      }
    }
  }
}
