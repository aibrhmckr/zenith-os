import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import yaml from 'js-yaml'
import { NsisUpdater } from 'electron-updater'
import { createApplicationUpdater } from '../src/main/services/applicationUpdater.js'

function fixture(options = {}) {
  const updater = new EventEmitter(),
    events = [],
    reports = [],
    installs = []
  updater.quitAndInstall = (...args) => installs.push(args)
  const service = createApplicationUpdater({
    updater,
    enabled: true,
    downloads: { report: (value) => reports.push(value) },
    publish: (channel, state) => events.push({ channel, state }),
    ...options
  })
  return { updater, service, events, reports, installs }
}

test('release lifecycle publishes complete OTA payloads and retains ready state independently of notifications', async () => {
  const { updater, service, events, reports, installs } = fixture()
  updater.checkForUpdates = async () => {
    updater.emit('checking-for-update')
    updater.emit('update-available', {
      version: '1.0.1',
      releaseDate: '2026-10-11',
      releaseNotes: 'Fixes'
    })
    updater.emit('download-progress', {
      percent: 78,
      bytesPerSecond: 1024,
      transferred: 78,
      total: 100
    })
    return {
      downloadPromise: Promise.resolve().then(() =>
        updater.emit('update-downloaded', { version: '1.0.1' })
      )
    }
  }
  assert.deepEqual(await service.check(), { success: true, ready: true })
  assert.deepEqual(
    events.map((event) => event.channel),
    ['app-update:checking', 'app-update:available', 'app-update:progress', 'app-update:downloaded']
  )
  assert.equal(events[1].state.releaseNotes, 'Fixes')
  assert.equal(events[1].state.releaseDate, '2026-10-11')
  assert.equal(events[2].state.bytesPerSecond, 1024)
  assert.equal(events[2].state.transferred, 78)
  assert.equal(events[2].state.total, 100)
  assert.equal(events[2].state.percent, 78)
  reports.length = 0 // Clearing history cannot clear the staged installer.
  assert.equal(service.snapshot().ready, true)
  service.snapshot().ready = false
  assert.equal(service.snapshot().ready, true, 'Snapshots cannot mutate service state')
  assert.deepEqual(installs, [], 'Downloading never forces a restart')
  assert.equal(updater.autoDownload, true)
  assert.equal(updater.autoInstallOnAppQuit, true)
  assert.equal(service.install(false).success, false)
  assert.equal(service.install(true).success, true)
  assert.deepEqual(installs, [[false, true]])
  updater.checkForUpdates = () => assert.fail('Do not redownload a staged update')
  assert.equal((await service.check()).ready, true)
})

test('network errors are deduplicated, synchronous failure releases the lease, and a retry can be current', async () => {
  const { updater, service, events, reports } = fixture()
  updater.checkForUpdates = () => {
    const error = Error('network timeout')
    updater.emit('error', error)
    throw error
  }
  assert.equal((await service.check()).success, false)
  assert.equal(events.length, 1)
  assert.equal(events[0].channel, 'app-update:error')
  assert.equal(events[0].state.message, 'network timeout')
  assert.equal(reports.length, 1)
  updater.checkForUpdates = async () => {
    updater.emit('checking-for-update')
    updater.emit('update-not-available', { version: '1.0.0' })
  }
  assert.equal((await service.check()).success, true)
  assert.equal(events.at(-1).channel, 'app-update:not-available')
  assert.equal(service.snapshot().status, 'up-to-date')
  assert.equal(service.install(true).success, false)
})

test('download rejection is surfaced, and installer failures preserve the staged update for retry', async () => {
  const { updater, service } = fixture()
  updater.checkForUpdates = async () => ({
    downloadPromise: Promise.reject(Error('checksum mismatch'))
  })
  assert.equal((await service.check()).error, 'checksum mismatch')
  assert.equal(service.snapshot().ready, false)
  updater.emit('update-downloaded', { version: '1.0.1' })
  updater.quitAndInstall = () => updater.emit('error', Error('installer denied'))
  assert.equal(service.install(true).error, 'installer denied')
  assert.equal(service.snapshot().ready, true)
  updater.quitAndInstall = () => {
    throw Error('spawn failed')
  }
  assert.equal(service.install(true).error, 'spawn failed')
})

test('development mode is a readable state and cannot download or install', async () => {
  const { updater, service, events } = fixture({ app: { isPackaged: false } })
  updater.checkForUpdates = () => assert.fail('No network in development')
  assert.equal(updater.autoDownload, false)
  assert.equal(updater.autoInstallOnAppQuit, false)
  assert.equal(service.snapshot().status, 'developer')
  assert.equal((await service.check()).developer, true)
  assert.equal(service.install(true).success, false)
  assert.deepEqual(events, [])
})

test('real NSIS updater registers installation on normal quit, not on a crash', () => {
  let onQuit
  const installs = []
  const updater = new NsisUpdater(null, {
    version: '1.0.0',
    name: 'zenith',
    isPackaged: true,
    onQuit: (callback) => {
      onQuit = callback
    }
  })
  updater.logger = null
  createApplicationUpdater({ updater, enabled: true, downloads: { report() {} } })
  // No binaries/network: exercise the real provider's quit hook with a stub installer.
  updater.install = (...args) => installs.push(args)
  updater.addQuitHandler()
  onQuit(1)
  assert.deepEqual(installs, [])
  onQuit(0)
  assert.deepEqual(installs, [[true, false]])
})

test('release packaging retains GitHub feed, NSIS differential artifacts and production updater dependency', () => {
  const config = yaml.load(
    fs.readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8')
  )
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.deepEqual(config.publish, {
    provider: 'github',
    owner: 'aibrhmckr',
    repo: 'zenith-os',
    releaseType: 'release'
  })
  assert.equal(config.win.target, 'nsis')
  assert.equal(config.nsis.differentialPackage, true)
  assert.equal(config.nsis.artifactName, '${name}-${version}-setup.${ext}')
  assert(pkg.dependencies['electron-updater'])
  assert.equal(pkg.scripts.release, 'electron-builder --publish always')
  assert.equal(pkg.scripts.prerelease, 'npm run build')
})
