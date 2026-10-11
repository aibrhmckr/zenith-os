import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { updateInstalledEmulators } from '../src/main/services/emulatorUpdates.js'
import { taskTitle, taskVisibility } from '../src/renderer/src/hooks/downloadPresentation.js'

test('installed update scan skips uninstalled files and emits a transient localized up-to-date notice', async (t) => {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'zenith-update-scan-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(join(root, 'cores'))
  for (const name of ['demo_libretro.dll', 'invalid_libretro.dll', 'metadata.json'])
    fs.writeFileSync(join(root, 'cores', name), 'fixture')
  const events = [],
    calls = []
  let coreResult = { success: true, upToDate: true }
  let rpcs3Result = { success: true, upToDate: true }
  const options = {
    retroarchDir: root,
    cores: {
      pathFor: (name) => (name === 'demo_libretro.dll' ? join(root, 'cores', name) : null),
      installNamed: async (name, update) => {
        calls.push([name, update])
        return coreResult
      }
    },
    updateRpcs3: async () => rpcs3Result,
    report: (event) => events.push(event)
  }
  const result = await updateInstalledEmulators(options)
  assert.deepEqual(result, { success: true, upToDate: true, checked: 2 })
  assert.deepEqual(calls, [['demo_libretro.dll', true]])
  assert.equal(events.length, 1)
  assert.equal(events[0].status, 'completed')
  assert.equal(events[0].phase, 'up-to-date')
  const tr = JSON.parse(
    fs.readFileSync(new URL('../src/renderer/src/locales/tr.json', import.meta.url))
  )
  assert.equal(
    taskTitle(events[0], (key) => tr[key] || key),
    'Tüm emülatörler ve çekirdekler güncel'
  )
  assert.equal(taskVisibility({ ...events[0], updatedAt: 1000 }, 5350), 'hidden')
  events.length = 0
  coreResult = { success: true }
  assert.equal((await updateInstalledEmulators(options)).upToDate, false)
  assert.deepEqual(events, [])
  rpcs3Result = { success: false, error: 'Network unavailable' }
  assert.deepEqual(await updateInstalledEmulators(options), rpcs3Result)
  assert.deepEqual(events, [], 'A failed check must never claim everything is current')
})

test('an empty installation receives a distinct no-installed-components notice', async (t) => {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'zenith-update-empty-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const events = []
  const result = await updateInstalledEmulators({
    retroarchDir: root,
    cores: {},
    report: (e) => events.push(e)
  })
  assert.equal(result.checked, 0)
  assert.equal(events[0].phase, 'not-installed')
})
