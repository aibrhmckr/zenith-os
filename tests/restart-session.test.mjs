import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { stopForRestart } from '../src/main/services/restartSession.js'

test('safe restart waits for close and launch cleanup, not merely process exit', async () => {
  const child = new EventEmitter()
  let killed = 0,
    cleaned,
    settled = false
  child.kill = () => {
    killed++
    return true
  }
  const cleanup = new Promise((resolve) => {
    cleaned = resolve
  })
  const pending = stopForRestart(child, cleanup).then(() => {
    settled = true
  })
  assert.equal(killed, 1)
  child.emit('exit', 3221226505)
  await Promise.resolve()
  assert.equal(settled, false)
  child.emit('close', 3221226505)
  await Promise.resolve()
  assert.equal(settled, false)
  cleaned()
  await pending
  assert.equal(settled, true)
})

test('safe restart refuses kill failure or timeout and removes listeners', async () => {
  const child = new EventEmitter()
  child.kill = () => false
  await assert.rejects(stopForRestart(child, Promise.resolve()), /Unable to stop/)
  assert.equal(child.listenerCount('close'), 0)
  child.kill = () => true
  await assert.rejects(stopForRestart(child, Promise.resolve(), 10), /Restart canceled/)
  assert.equal(child.listenerCount('close'), 0)
})
