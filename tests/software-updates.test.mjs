import test from 'node:test'
import assert from 'node:assert/strict'
import { createSoftwareUpdates } from '../src/main/services/softwareUpdates.js'

const deferred = () => {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test('one explicit action checks both providers, coalesces clicks and waits for emulator writes before restart', async () => {
  const emulators = deferred(),
    events = [],
    calls = []
  const service = createSoftwareUpdates({
    canStart: () => true,
    checkApp: async () => {
      calls.push('app')
      return { success: true, ready: true }
    },
    updateEmulators: () => {
      calls.push('emulators')
      return emulators.promise
    },
    installApp: () => {
      calls.push('install')
      return { success: true }
    },
    report: (event) => events.push(event)
  })
  assert.deepEqual(calls, [])
  assert.equal(service.start().success, true)
  assert.equal(service.start().alreadyRunning, true)
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(calls, ['app', 'emulators'])
  assert.equal(service.busy(), true)
  assert.equal(events[0].status, 'active')
  emulators.resolve({ success: true })
  assert.equal((await service.whenIdle()).success, true)
  assert.deepEqual(calls, ['app', 'emulators', 'install'])
  assert.equal(events.at(-1).status, 'completed')
  assert.equal(service.busy(), false)
})

test('busy sessions create no task or update request', () => {
  const unexpected = () => assert.fail('Maintenance must not start')
  const service = createSoftwareUpdates({
    canStart: () => false,
    checkApp: unexpected,
    updateEmulators: unexpected,
    installApp: unexpected,
    report: unexpected
  })
  assert.equal(service.start().success, false)
})

test('provider failures still check the other provider and never restart over failed emulator maintenance', async () => {
  for (const failing of ['app', 'emulators']) {
    const events = [],
      calls = []
    const service = createSoftwareUpdates({
      canStart: () => true,
      checkApp: async () => {
        calls.push('app')
        if (failing === 'app') throw Error('offline')
        return { success: true, ready: true }
      },
      updateEmulators: async () => {
        calls.push('emulators')
        return failing === 'emulators' ? { success: false, error: 'locked' } : { success: true }
      },
      installApp: () => assert.fail('Must not restart'),
      report: (event) => events.push(event)
    })
    service.start()
    assert.equal((await service.whenIdle()).success, false)
    assert.deepEqual(calls, ['app', 'emulators'])
    assert.equal(events.at(-1).status, 'failed')
    assert.match(events.at(-1).error, /offline|locked/)
    assert.equal(service.busy(), false)
  }
})

test('up-to-date results complete without restarting; install rejection is visible', async () => {
  for (const ready of [false, true]) {
    const events = []
    const service = createSoftwareUpdates({
      canStart: () => true,
      checkApp: async () => ({ success: true, ready }),
      updateEmulators: async () => ({ success: true, upToDate: true }),
      installApp: () => {
        assert(ready)
        return { success: false, error: 'installation unavailable' }
      },
      report: (event) => events.push(event)
    })
    service.start()
    assert.equal((await service.whenIdle()).success, !ready)
    assert.equal(events.at(-1).status, ready ? 'failed' : 'completed')
  }
})
