import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { createDownloadCenter } from '../src/main/services/downloadCenter.js'
import { createApplicationUpdater } from '../src/main/services/applicationUpdater.js'
import {
  taskVisibility,
  taskTitle,
  taskError
} from '../src/renderer/src/hooks/downloadPresentation.js'

test('clear history persists removal of finished/failed jobs without touching pending work', (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zenith-clear-history-'))
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }))
  const events = []
  const center = createDownloadCenter({ userData, publish: (tasks) => events.push(tasks) })
  for (const status of ['completed', 'failed', 'interrupted', 'active', 'queued'])
    center.report({ id: status, status })
  assert.deepEqual(
    center
      .clearHistory()
      .map((t) => t.id)
      .sort(),
    ['active', 'queued']
  )
  assert.equal(events.at(-1).length, 2)
  assert.equal(JSON.parse(fs.readFileSync(path.join(userData, 'downloads.json'))).length, 2)
  center.report({ id: 'active', status: 'completed' })
  assert.equal(center.snapshot().find((t) => t.id === 'active').status, 'completed')
})

test('notification presentation hides URL/path diagnostics and keeps helpful error categories', () => {
  const t = (key) => key
  assert.equal(
    taskError({ error: 'HTTP 403 https://buildbot.libretro.com/?secret=123' }, t),
    'downloadErrorNetwork'
  )
  assert.equal(
    taskError({ error: 'EPERM C:\\Code\\zenith\\core.dll' }, t),
    'downloadErrorPermission'
  )
  assert.equal(taskError({ error: 'unexpected /home/private/core.so' }, t), 'downloadErrorGeneric')
  assert.equal(taskError({ error: 'ENOSPC' }, t), 'downloadErrorSpace')
  assert.equal(taskTitle({ name: 'C:\\Code\\zenith\\core.dll' }, t), 'downloadTask')
  assert.equal(taskTitle({ name: 'https://buildbot.libretro.com/file' }, t), 'downloadTask')
})

test('completed rows fade after four seconds, expire, and retries retain their own lifecycle', () => {
  const task = { id: 'rpcs3', status: 'completed', updatedAt: 1000 }
  assert.equal(taskVisibility(task, 4999), 'visible')
  assert.equal(taskVisibility(task, 5000), 'leaving')
  assert.equal(taskVisibility(task, 5350), 'hidden')
  assert.equal(taskVisibility(task, 100000), 'hidden')
  assert.equal(taskVisibility(task, 2000, 1500), 'hidden')
  for (const status of ['active', 'queued', 'failed', 'interrupted']) {
    assert.equal(taskVisibility({ ...task, status }, 100000, 90000), 'visible')
  }
  assert.equal(taskVisibility({ ...task, updatedAt: 100001 }, 100002, 90000), 'visible')
})

test('download titles are localized without raw translation keys', () => {
  for (const [locale, expected] of [
    ['en', 'RPCS3 Update'],
    ['tr', 'RPCS3 Güncellemesi']
  ]) {
    const messages = JSON.parse(
      fs.readFileSync(new URL(`../src/renderer/src/locales/${locale}.json`, import.meta.url))
    )
    const t = (key) => messages[key] || key
    assert.equal(taskTitle({ name: 'RPCS3', kind: 'rpcs3' }, t), expected)
    assert.equal(taskTitle({ name: 'Zenith OS', kind: 'app' }, t), messages.appUpdateTitle)
    assert.equal(taskTitle({ name: 'Example', kind: 'future-provider' }, t), 'Example')
    assert.equal(
      taskTitle({ name: 'Example', kind: 'video' }, t),
      `Example ${messages.taskKind_video}`
    )
  }
})

test('download history reports real percentages, preserves completion and interrupts stale jobs', (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zenith-downloads-'))
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }))
  const events = []
  const center = createDownloadCenter({ userData, publish: (value) => events.push(value) })
  center.report({
    id: 'video',
    name: 'Example',
    kind: 'video',
    status: 'active',
    received: 25,
    total: 100
  })
  center.flush()
  assert.equal(events.at(-1)[0].percent, 25)
  const restored = createDownloadCenter({ userData })
  assert.equal(restored.snapshot()[0].status, 'interrupted')
  center.report({ id: 'video', status: 'completed' })
  assert.equal(center.snapshot()[0].percent, 100)
  center.report({ id: 'video', status: 'active', received: 0, total: null })
  assert.equal(center.snapshot()[0].percent, null)
  center.report({ id: 'video', status: 'failed', error: 'network unavailable' })
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(userData, 'downloads.json')))[0].error,
    'network unavailable'
  )
})

test('updater coalesces checks, stages differential downloads and requires an idle explicit restart', async () => {
  const updater = new EventEmitter(),
    events = []
  let finish,
    calls = 0,
    installed = 0,
    idle = false
  updater.checkForUpdates = async () => {
    calls++
    updater.emit('checking-for-update')
    return {
      downloadPromise: new Promise((resolve) => {
        finish = resolve
      })
    }
  }
  updater.quitAndInstall = () => installed++
  const service = createApplicationUpdater({
    updater,
    downloads: { report: (e) => events.push(e) },
    enabled: true,
    canInstall: () => idle
  })
  const a = service.check(),
    b = service.check()
  await Promise.resolve()
  assert.equal(calls, 1)
  assert.equal(updater.disableDifferentialDownload, false)
  assert.equal(updater.autoInstallOnAppQuit, true)
  updater.emit('download-progress', { transferred: 45, total: 100, percent: 45 })
  assert.equal(events.at(-1).received, 45)
  updater.emit('update-downloaded', { version: '1.0.1' })
  finish()
  await Promise.all([a, b])
  assert.equal(service.install(true).success, false)
  idle = true
  assert.equal(service.install(false).success, false)
  assert.equal(service.install(true).success, true)
  assert.equal(installed, 1)
})

test('updater surfaces provider errors without rejecting the caller', async () => {
  const updater = new EventEmitter(),
    events = []
  updater.checkForUpdates = async () => {
    throw Error('release unavailable')
  }
  const service = createApplicationUpdater({
    updater,
    downloads: { report: (e) => events.push(e) },
    enabled: true
  })
  assert.equal((await service.check()).success, false)
  assert.equal(events.at(-1).status, 'failed')
})
