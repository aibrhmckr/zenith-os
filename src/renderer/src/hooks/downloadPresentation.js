export const COMPLETED_HOLD_MS = 4000
export const COMPLETED_FADE_MS = 350
export const isUpdateTask = (task) =>
  ['app', 'rpcs3', 'core', 'emulatorUpdate', 'softwareUpdate'].includes(task.kind)

/** Never render raw provider errors: they can contain URLs, query tokens and local paths. */
export function taskError(task, t) {
  const error = String(task.error || '')
  if (!error) return ''
  if (/ENOSPC|disk.*full/i.test(error)) return t('downloadErrorSpace')
  if (/EACCES|EPERM|permission|access denied/i.test(error)) return t('downloadErrorPermission')
  if (/network|fetch|offline|timeout|timed out|HTTP|ECONN|ENOTFOUND/i.test(error))
    return t('downloadErrorNetwork')
  return t('downloadErrorGeneric')
}

const safeName = (value) =>
  typeof value === 'string' && !/(?:https?:|file:|[a-z]:[\\/]|\\\\|\/)/i.test(value)

/** Age completions from their Main timestamp, so reopening the panel cannot revive old rows. */
export function taskVisibility(task, now, clearedAt = 0) {
  if (
    task.scope === 'software-update' ||
    (task.kind === 'softwareUpdate' && ['active', 'queued'].includes(task.status))
  )
    return 'hidden'
  if (task.status !== 'completed') return 'visible'
  const completedAt = Number(task.updatedAt) || 0
  if (completedAt <= clearedAt || now >= completedAt + COMPLETED_HOLD_MS + COMPLETED_FADE_MS)
    return 'hidden'
  return now >= completedAt + COMPLETED_HOLD_MS ? 'leaving' : 'visible'
}

/** Unknown provider kinds must never expose internal translation keys in the UI. */
export function taskTitle(task, t) {
  if (task.kind === 'softwareUpdate') return t('softwareUpdate')
  if (task.kind === 'emulatorUpdate')
    return t(
      task.phase === 'up-to-date'
        ? 'emulatorsUpToDate'
        : task.phase === 'not-installed'
          ? 'noInstalledEmulators'
          : 'updateEmulators'
    )
  if (task.kind === 'rpcs3') return t('rpcs3UpdateTitle')
  if (task.kind === 'app') return t('appUpdateTitle')
  const key = 'taskKind_' + task.kind
  const suffix = task.kind ? t(key) : ''
  return [
    safeName(task.name) && task.name ? task.name : t('downloadTask'),
    suffix === key ? '' : suffix
  ]
    .filter(Boolean)
    .join(' ')
}
