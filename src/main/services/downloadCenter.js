import { createBatchedWriter } from './workScheduling.js'
import fs from 'node:fs'
import { join } from 'node:path'

/** Main owns task identities and paths. Renderer receives snapshots, never download URLs. */
export function createDownloadCenter({ userData, publish = () => {}, now = Date.now }) {
  const file = join(userData, 'downloads.json')
  const tasks = new Map()
  let timer
  try {
    for (const task of JSON.parse(fs.readFileSync(file, 'utf8')).slice(0, 100)) {
      if (typeof task.id !== 'string') continue
      tasks.set(task.id, {
        ...task,
        ...(task.phase === 'ready-to-install' ? { phase: 'recheck-required' } : {}),
        ...(task.status === 'active' ? { status: 'interrupted', percent: null } : {})
      })
    }
  } catch {
    /* A missing or damaged history never blocks the launcher. */
  }
  const snapshot = () => [...tasks.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  const writer = createBatchedWriter(async () => {
    const value = snapshot()
    await fs.promises.mkdir(userData, { recursive: true })
    await fs.promises.writeFile(file + '.tmp', JSON.stringify(value))
    await fs.promises.rename(file + '.tmp', file)
  }, 1000)
  const persist = () =>
    writer.request().catch((error) => console.warn('[Downloads] History:', error.message))
  const publishNow = () => {
    clearTimeout(timer)
    timer = null
    const value = snapshot()
    const history = value.filter((item) => !['active', 'queued'].includes(item.status))
    for (const item of history.slice(80)) tasks.delete(item.id)
    publish(snapshot())
  }
  const flush = async () => {
    publishNow()
    const pending = persist()
    await writer.flush()
    await pending
  }
  const report = (patch) => {
    if (typeof patch.id !== 'string') return
    const previous = tasks.get(patch.id)
    const restarting = patch.status === 'active' && previous?.status !== 'active'
    const task = { ...(restarting ? {} : previous), ...patch, updatedAt: now() }
    if (task.status === 'completed') task.percent = 100
    else if (patch.total !== undefined || patch.received !== undefined)
      task.percent =
        task.total > 0
          ? Math.min(99, Math.max(0, Math.round((task.received / task.total) * 100)))
          : null
    else if (!Number.isFinite(task.percent)) task.percent = null
    tasks.set(task.id, task)
    if (task.status !== 'active') {
      publishNow()
      void persist()
    } else if (!timer) {
      timer = setTimeout(() => {
        publishNow()
        void persist()
      }, 150)
      timer.unref?.()
    }
  }
  // Clearing history never cancels or conceals active/queued work.
  const clearHistory = () => {
    for (const [id, task] of tasks) {
      if (!['active', 'queued'].includes(task.status)) tasks.delete(id)
    }
    publishNow()
    void persist()
    return snapshot()
  }
  return { report, snapshot, flush, clearHistory }
}
