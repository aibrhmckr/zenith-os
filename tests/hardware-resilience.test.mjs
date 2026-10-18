import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { load } from 'js-yaml'
import {
  classifyGpu,
  createHardwareDetector,
  rpcs3HardwareProfile
} from '../src/main/services/hardwareDetector.js'
import {
  classifyCrash,
  watchEmulator,
  createCrashReporter
} from '../src/main/services/crashResilience.js'
import { prepareRpcs3Config } from '../src/main/services/rpcs3Config.js'

test('AMD iGPUs, Intel integrated, hybrid inactive dGPUs and unknown GPUs use conservative profiles', () => {
  for (const deviceString of ['AMD Radeon 610M', 'AMD Radeon Graphics', 'Intel UHD Graphics']) {
    const result = classifyGpu({ gpuDevice: [{ deviceString, active: true }] })
    assert.equal(result.classification, 'fallback')
    assert.equal(rpcs3HardwareProfile(result).Video['Shader Precision'], 'Low')
  }
  assert.equal(
    classifyGpu({ gpuDevice: [{ vendorId: 0x1002, active: true }] }).classification,
    'fallback'
  )
  for (const active of [false, undefined]) {
    assert.equal(
      classifyGpu({ gpuDevice: [{ vendorId: 0x10de, active }] }).classification,
      'fallback',
      'A detected but not explicitly active dedicated GPU must not select the active dGPU profile'
    )
  }
  assert.equal(
    classifyGpu({
      gpuDevice: [
        { deviceString: 'Intel UHD', active: true },
        { vendorId: 0x10de, active: false }
      ]
    }).classification,
    'fallback'
  )
  for (const deviceString of ['NVIDIA GeForce RTX 4060', 'AMD Radeon RX 7800 XT', 'Intel Arc A770'])
    assert.equal(
      classifyGpu({ gpuDevice: [{ deviceString, active: true }] }).classification,
      'dedicated'
    )
})

test('GPU API rejection/timeout does not block launch and concurrent queries are deduplicated', async () => {
  let calls = 0
  const detector = createHardwareDetector({
    app: {
      getGPUInfo: () => {
        calls++
        return new Promise(() => {})
      }
    },
    timeoutMs: 10
  })
  const [a, b] = await Promise.all([detector.detect(), detector.detect()])
  assert.equal(calls, 1)
  assert(a.unavailable && b.unavailable)
  const broken = createHardwareDetector({
    app: {
      getGPUInfo: async () => {
        throw Error('driver crash')
      }
    }
  })
  assert.equal((await broken.detect()).profile, 'conservative')
})

test('RPCS3 hardware settings persist without destroying unrelated configuration or caches', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zenith-hardware-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.writeFile(path.join(root, 'config.yml'), 'Audio:\n  Master Volume: 70\n')
  await fs.writeFile(path.join(root, 'shader-cache'), 'keep')
  prepareRpcs3Config({
    configDirectory: root,
    platform: 'linux',
    hardware: { classification: 'fallback' }
  })
  let config = load(await fs.readFile(path.join(root, 'config.yml'), 'utf8'))
  assert.equal(config.Core['SPU Block Size'], 'Mega')
  assert.equal(config.Video['Resolution Scale'], 100)
  assert.equal(config.Video['Shader Precision'], 'Low')
  assert.equal(config.Audio['Master Volume'], 70)
  assert.equal(await fs.readFile(path.join(root, 'shader-cache'), 'utf8'), 'keep')
  prepareRpcs3Config({
    configDirectory: root,
    platform: 'linux',
    hardware: { classification: 'dedicated' }
  })
  config = load(await fs.readFile(path.join(root, 'config.yml'), 'utf8'))
  assert.equal(config.Video['Shader Precision'], 'High')
})

test('GPU crashes settle once, retain signed Windows exit codes and persist bounded diagnostics', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zenith-crash-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const reporter = createCrashReporter({ userData: root }),
    pending = [],
    results = []
  const child = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdout = new EventEmitter()
  watchEmulator(child, {
    label: 'RPCS3',
    reporter: { record: (report) => pending.push(reporter.record(report)) },
    finish: (value) => results.push(value)
  })
  child.stderr.emit('data', 'x'.repeat(20000) + ' VK_ERROR_DEVICE_LOST')
  child.emit('exit', -1073741819)
  child.emit('close', -1073741819)
  child.emit('error', Error('late'))
  await Promise.all(pending)
  assert.equal(results.length, 1)
  assert.equal(results[0].reason, 'gpu_driver')
  assert.equal(results[0].codeHex, '0xc0000005')
  const record = JSON.parse(
    (await fs.readFile(path.join(root, 'logs/crash-report.log'), 'utf8')).trim()
  )
  assert.equal(record.emulator, 'RPCS3')
  assert(record.output.length <= 16384)
  assert.equal(classifyCrash({ code: 0xc0000135 }).reason, 'missing_library')
  assert.equal(classifyCrash({ code: 1, output: 'VK_ERROR_OUT_OF_DEVICE_MEMORY' }).reason, 'memory')
  assert.equal(classifyCrash({ code: 0xc0000409 }).reason, 'emulator_crash')
})

test('clean exit and explicit stop do not generate crash reports; spawn errors release the session', () => {
  for (const killed of [false, true]) {
    const child = new EventEmitter()
    child.killed = killed
    let result = 'unset'
    watchEmulator(child, {
      reporter: { record: () => assert.fail('no crash') },
      finish: (value) => {
        result = value
      }
    })
    child.emit('exit', killed ? null : 0, killed ? 'SIGTERM' : null)
    assert.equal(result, null)
  }
  const child = new EventEmitter(),
    results = []
  const watcher = watchEmulator(child, {
    reporter: { record: () => {} },
    finish: (value) => results.push(value)
  })
  watcher.fail(Error('spawn failed'))
  child.emit('close', -1)
  assert.equal(results.length, 1)
})
