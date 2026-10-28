import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { synthesize, SAMPLE_RATE } from '../scripts/generate-sounds.js'
import { createApplicationUpdater } from '../src/main/services/applicationUpdater.js'
import { createSoftwareUpdates } from '../src/main/services/softwareUpdates.js'
import { taskVisibility } from '../src/renderer/src/hooks/downloadPresentation.js'

test('generated original WAVs have exact PCM framing, quiet endpoints and unclipped non-silent samples', () => {
  for (const [name, duration] of Object.entries({
    navigate: 0.085,
    toggle: 0.22,
    back: 0.2,
    launch: 0.9
  })) {
    const wav = synthesize(name)
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF')
    assert.equal(wav.readUInt32LE(4), wav.length - 8)
    assert.equal(wav.readUInt32LE(24), SAMPLE_RATE)
    assert.equal(wav.readUInt16LE(22), 1)
    assert.equal(wav.readUInt16LE(34), 16)
    assert.equal(wav.readUInt32LE(40), Math.round(duration * SAMPLE_RATE) * 2)
    const samples = Array.from({ length: (wav.length - 44) / 2 }, (_, i) =>
      wav.readInt16LE(44 + i * 2)
    )
    assert.equal(samples[0], 0)
    assert(Math.abs(samples.at(-1)) < 10, name + ' click-free ending')
    assert(Math.max(...samples.map(Math.abs)) > 1000)
    assert(Math.max(...samples.map(Math.abs)) < 25000)
    assert(
      Math.abs(samples.reduce((sum, sample) => sum + sample, 0) / samples.length) < 100,
      name + ' has no significant DC offset'
    )
    assert(
      samples.every((sample, i) => !i || Math.abs(sample - samples[i - 1]) < 2200),
      name + ' has no abrupt waveform discontinuities'
    )
    assert.deepEqual(wav, synthesize(name), 'Reproducible build artifact')
  }
})

test('developer updater never contacts Releases or installs even when explicitly enabled', async () => {
  const updater = new EventEmitter()
  updater.checkForUpdates = () => assert.fail('Developer mode must not contact Releases')
  updater.quitAndInstall = () => assert.fail('Developer mode must not run an installer')
  const service = createApplicationUpdater({
    updater,
    app: { isPackaged: false },
    enabled: true,
    downloads: { report: () => assert.fail('No failed release notification') }
  })
  assert.deepEqual(await service.check(), { success: true, upToDate: true, developer: true })
  assert.equal(service.install(true).success, false)
})

test('developer combined update checks emulators, streams component progress and publishes one visible summary', async () => {
  const events = []
  const service = createSoftwareUpdates({
    app: { isPackaged: false },
    canStart: () => true,
    checkApp: () => assert.fail('No installer query'),
    installApp: () => assert.fail('No restart'),
    updateEmulators: async (progress) => {
      progress({ name: 'stella_libretro.dll', completedComponents: 2, totalComponents: 6 })
      progress({ name: 'stella_libretro.dll', received: 90, total: 100 })
      assert.equal(events.at(-1).componentPercent, 90)
      assert.equal(events.at(-1).completedComponents, 2)
      assert.equal(events.at(-1).totalComponents, 6)
      return { success: true }
    },
    report: (event) => events.push({ ...event, updatedAt: 1000 })
  })
  service.start()
  assert.equal((await service.whenIdle()).success, true)
  assert.equal(events.at(-1).developer, true)
  assert.equal(events.at(-1).status, 'completed')
  assert.equal(events.filter((event) => taskVisibility(event, 1001) === 'visible').length, 1)
})
