import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import yaml from 'js-yaml'
import adapter from '../scripts/nsis-process.cjs'

test('NSIS generator retains Windows env and retries a transient spawn failure without a shell', async () => {
  let calls = 0
  const waits = [],
    logs = []
  const owner = {}
  const run = adapter.resilientNsisExec(
    async function (file, args, options) {
      assert.equal(this, owner)
      assert(path.isAbsolute(file))
      assert.deepEqual(args, [])
      assert.equal(options.env.SystemRoot, 'C:\\Windows')
      assert.equal(options.env.PATH, 'fixture-path')
      assert.equal(options.env.__COMPAT_LAYER, 'RunAsInvoker')
      assert.equal(options.windowsHide, true)
      assert.equal(options.shell, undefined)
      if (++calls < 3) throw Object.assign(Error('spawn UNKNOWN'), { code: 'UNKNOWN' })
      return 'complete'
    },
    {
      env: { SystemRoot: 'C:\\Windows', PATH: 'fixture-path' },
      wait: async (ms) => waits.push(ms),
      log: (msg) => logs.push(msg)
    }
  )
  assert.equal(
    await run.call(owner, 'dist/setup.exe', [], { env: { __COMPAT_LAYER: 'RunAsInvoker' } }),
    'complete'
  )
  assert.deepEqual(waits, [250, 750])
  assert.equal(logs.length, 2)
})

test('NSIS retries are bounded; real exit failures and unrelated tools are not retried', async () => {
  const options = { env: { __COMPAT_LAYER: 'RunAsInvoker' } }
  let attempts = 0
  const run = adapter.resilientNsisExec(
    async () => {
      attempts++
      throw Object.assign(Error('locked'), { code: 'EBUSY' })
    },
    { wait: async () => {}, log: () => {} }
  )
  await assert.rejects(run('setup.exe', [], options), /locked/)
  assert.equal(attempts, 5)
  attempts = 0
  await assert.rejects(run('other.exe', ['/S'], options), /locked/)
  assert.equal(attempts, 1)
  const error = Object.assign(Error('NSIS failed'), { code: 1 })
  const fail = adapter.resilientNsisExec(
    async () => {
      throw error
    },
    { wait: () => assert.fail('No retry for exit code 1') }
  )
  await assert.rejects(fail('setup.exe', [], options), (e) => e === error)
})

test('Windows default is assisted NSIS with directory selection and no differential payload', async () => {
  const config = yaml.load(
    await readFile(new URL('../electron-builder.yml', import.meta.url), 'utf8')
  )
  assert.equal(config.win.target, 'nsis')
  assert.equal(config.win.signAndEditExecutable, false)
  assert.equal(config.win.forceCodeSigning, false)
  assert.equal(config.nsis.oneClick, false)
  assert.equal(config.nsis.perMachine, false)
  assert.equal(config.nsis.allowToChangeInstallationDirectory, true)
  assert.equal(config.nsis.differentialPackage, false)
  for (const key of ['createDesktopShortcut', 'createStartMenuShortcut', 'runAfterFinish'])
    assert.equal(config.nsis[key], true)
})
