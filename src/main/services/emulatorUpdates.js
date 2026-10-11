import fs from 'node:fs/promises'
import { join } from 'node:path'

/** Check installed components only. A successful no-op emits a short notice, never a download job. */
export async function updateInstalledEmulators({
  retroarchDir,
  cores,
  updateRpcs3,
  report,
  onProgress = () => {}
}) {
  const results = []
  const names = await fs.readdir(join(retroarchDir, 'cores')).catch((error) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  const installed = names.filter((name) => cores.pathFor(name))
  const totalComponents = installed.length + (updateRpcs3 ? 1 : 0)
  const progress = (name) =>
    onProgress({ name, completedComponents: results.length, totalComponents })
  progress(installed[0] || (updateRpcs3 ? 'RPCS3' : ''))
  for (const name of installed) {
    progress(name)
    results.push(await cores.installNamed(name, true))
    progress(name)
  }
  if (updateRpcs3) {
    progress('RPCS3')
    results.push(await updateRpcs3())
    progress('RPCS3')
  }
  const failed = results.find((result) => !result.success)
  if (failed) return { success: false, error: failed.error || 'Emulator update failed.' }
  const upToDate = results.every((result) => result.upToDate)
  if (upToDate)
    report({
      id: 'emulators-update',
      name: 'Emulators',
      kind: 'emulatorUpdate',
      status: 'completed',
      phase: results.length ? 'up-to-date' : 'not-installed',
      error: null
    })
  return { success: true, upToDate, checked: results.length }
}
