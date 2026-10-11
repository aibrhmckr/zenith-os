/** Stage official release updates in the background; installation always requires an explicit action. */
export function createApplicationUpdater({
  updater,
  downloads,
  enabled,
  app = { isPackaged: true },
  canInstall = () => true
}) {
  let pending = null,
    ready = false
  const report = (value) =>
    downloads.report({ id: 'zenith-update', name: 'Zenith OS', kind: 'app', ...value })
  updater.autoDownload = true
  updater.autoInstallOnAppQuit = false
  updater.allowPrerelease = false
  updater.allowDowngrade = false
  updater.disableDifferentialDownload = false
  updater.on('checking-for-update', () => {
    ready = false
    report({ status: 'active', phase: 'checking', percent: null })
  })
  updater.on('update-available', (info) =>
    report({ status: 'active', phase: 'downloading', version: info.version })
  )
  updater.on('update-not-available', () => report({ status: 'completed', phase: 'up-to-date' }))
  updater.on('download-progress', (value) =>
    report({
      status: 'active',
      phase: 'downloading',
      received: value.transferred,
      total: value.total,
      percent: value.percent
    })
  )
  updater.on('update-downloaded', (info) => {
    ready = true
    report({ status: 'completed', phase: 'ready-to-install', version: info.version })
  })
  updater.on('error', (error) => report({ status: 'failed', error: error.message }))
  return {
    check() {
      if (!app.isPackaged)
        return Promise.resolve({ success: true, upToDate: true, developer: true })
      if (!enabled)
        return Promise.resolve({ success: false, error: 'Updates require an installed release.' })
      if (ready) return Promise.resolve({ success: true, ready: true })
      if (pending) return pending
      pending = (async () => {
        try {
          const result = await updater.checkForUpdates()
          await result?.downloadPromise
          return { success: true, ready }
        } catch (error) {
          report({ status: 'failed', error: error.message })
          return { success: false, error: error.message }
        } finally {
          pending = null
        }
      })()
      return pending
    },
    install(confirmed) {
      if (!app.isPackaged || !enabled || !ready || confirmed !== true || !canInstall())
        return {
          success: false,
          error: 'Stop the game and running setup before installing a ready update.'
        }
      updater.quitAndInstall(false, true)
      return { success: true }
    }
  }
}
