/** Check both providers together; stage application updates without forcing an immediate restart. */
export function createSoftwareUpdates({
  canStart,
  checkApp,
  updateEmulators,
  report,
  app = { isPackaged: true }
}) {
  let pending = null
  let state = {}
  const publish = (value) =>
    report({
      id: 'software-update',
      name: 'Zenith OS',
      kind: 'softwareUpdate',
      ...(state = { ...state, ...value })
    })
  const run = async () => {
    const results = await Promise.allSettled([
      Promise.resolve().then(() =>
        app.isPackaged ? checkApp() : { success: true, developer: true }
      ),
      Promise.resolve().then(() => updateEmulators(progress))
    ])
    const outcomes = results.map((result) =>
      result.status === 'fulfilled'
        ? result.value || { success: false }
        : { success: false, error: result.reason?.message || 'Update failed.' }
    )
    const failed = outcomes.find((result) => !result?.success)
    if (failed) throw Error(failed.error || 'Update failed.')
    publish({
      status: 'completed',
      phase: outcomes[0].ready ? 'ready-to-install' : 'finished',
      error: null,
      percent: 100
    })
    return { success: true, ready: Boolean(outcomes[0].ready) }
  }
  // Provider events are transient detail for Settings, not individual notification cards.
  const progress = (value) => {
    const percent = Number.isFinite(value.percent)
      ? value.percent
      : value.total > 0 && Number.isFinite(value.received)
        ? Math.round((value.received / value.total) * 100)
        : null
    publish({
      status: 'active',
      phase: value.phase || 'checking',
      component: value.name || value.component || state.component,
      componentPercent: value.status === 'completed' ? 100 : percent,
      ...(Number.isFinite(value.completedComponents)
        ? { completedComponents: value.completedComponents, totalComponents: value.totalComponents }
        : {})
    })
  }
  return {
    progress,
    start() {
      if (pending) return { success: true, alreadyRunning: true }
      if (!canStart())
        return { success: false, error: 'Stop the game or wait for current maintenance.' }
      state = {
        developer: !app.isPackaged,
        component: null,
        componentPercent: null,
        completedComponents: 0,
        totalComponents: 0
      }
      publish({ status: 'active', phase: 'checking', percent: null, error: null })
      pending = run()
        .catch((error) => {
          publish({ status: 'failed', phase: 'failed', error: error.message })
          return { success: false, error: error.message }
        })
        .finally(() => {
          pending = null
        })
      return { success: true }
    },
    busy: () => pending !== null,
    whenIdle: () => pending || Promise.resolve({ success: true })
  }
}
