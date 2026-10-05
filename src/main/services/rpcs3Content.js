import fs from 'node:fs/promises'
import { join, dirname, extname, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { assertOwnedPath } from './rpcs3Download.js'

/** Read a bounded header for native format checks; never load a multi-GB package into RAM. */
async function header(file, length) {
  const handle = await fs.open(file, 'r')
  try {
    const data = Buffer.alloc(length)
    const { bytesRead } = await handle.read(data, 0, length, 0)
    return data.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/** Get the PS3 title ID from a standard package content ID (no decryption/license handling). */
export async function packageTitle(file) {
  const data = await header(file, 128)
  if (data.length < 128 || data.readUInt32BE(0) !== 0x7f504b47)
    throw Error('Invalid PS3 PKG header.')
  const title = data
    .toString('ascii', 0x30, 0x60)
    .replace(/\0.*$/s, '')
    .match(/^[A-Z]{2}\d{4}-([A-Z]{4}\d{5})_[A-Z0-9-]+$/)?.[1]
  if (!title) throw Error('PKG has no supported PS3 content ID.')
  return title
}

/** Run a bounded, hidden CLI job and retain diagnostics. Never use --no-gui for installation. */
export function runRpcs3Installer(
  executable,
  args,
  { cwd, env, signal, spawnImpl = spawn, timeoutMs = 30 * 60 * 1000 }
) {
  return new Promise((resolveJob, reject) => {
    let child,
      output = '',
      failure,
      settled = false
    const abort = () => {
      failure = Error('RPCS3 installation canceled or timed out.')
      child?.kill()
    }
    const timer = setTimeout(abort, timeoutMs)
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolveJob(output)
    }
    try {
      signal?.throwIfAborted()
      child = spawnImpl(executable, args, {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      signal?.addEventListener('abort', abort, { once: true })
      const collect = (data) => {
        output = (output + data.toString()).slice(-1024 * 1024)
      }
      child.stdout?.on('data', collect)
      child.stderr?.on('data', collect)
      child.once('error', (error) => finish(error))
      child.once('close', (code) =>
        finish(
          failure ||
            (code !== 0
              ? Object.assign(Error(`RPCS3 installer exited (${code}). ${output.slice(-2000)}`), {
                  code: 'RPCS3_INSTALL_EXIT',
                  exitCode: code
                })
              : null)
        )
      )
    } catch (error) {
      finish(error)
    }
  })
}

/**
 * Install a user-picked PUP/PKG with the upstream headless CLI. Exit code alone is insufficient:
 * firmware uses physical readiness after process close, even on teardown failure; PKG additionally
 * requires a fresh success log. Inputs are copied to private staging,
 * never changed in place, downloaded, or placed in the source tree. Caller serializes maintenance.
 */
export async function installRpcs3Content({
  runtime,
  kind,
  file,
  signal,
  progress = () => {},
  run = runRpcs3Installer,
  platform = process.platform
}) {
  if (!['firmware', 'package'].includes(kind)) throw Error('Invalid RPCS3 installation type.')
  const status = runtime.status()
  if (!status.executableReady) throw Error('Install RPCS3 before installing firmware or packages.')
  if (status.error === 'rpcs3_status_failed') throw Error(status.message)
  const stat = await fs.stat(file)
  const limit = (kind === 'firmware' ? 2 : 64) * 1024 * 1024 * 1024
  if (
    !stat.isFile() ||
    stat.size < 128 ||
    stat.size > limit ||
    extname(file).toLowerCase() !== (kind === 'firmware' ? '.pup' : '.pkg')
  )
    throw Error('Invalid installation file or size.')
  if (
    kind === 'firmware' &&
    !(await header(file, 8)).equals(Buffer.from([83, 67, 69, 85, 70, 0, 0, 0]))
  )
    throw Error('Invalid PS3 PUP header.')
  const title = kind === 'package' ? await packageTitle(file) : null
  const target = kind === 'firmware' ? status.firmware.directory : runtime.dataDirectory('dev_hdd0')
  // Installation may not follow user VFS links outside this app's managed runtime.
  await assertOwnedPath(runtime.directory, target)
  await fs.mkdir(target, { recursive: true })
  const stage = await fs.mkdtemp(join(dirname(runtime.directory), '.rpcs3-content-'))
  const copy = join(stage, kind === 'firmware' ? 'PS3UPDAT.PUP' : 'input.pkg')
  const env = runtime.environment()
  const logDirectory =
    platform === 'win32' ? join(runtime.configDirectory, 'log') : join(env.XDG_CACHE_HOME, 'rpcs3')
  const log = join(logDirectory, 'RPCS3.log'),
    oldLog = join(stage, 'previous.log')
  let savedLog = false
  try {
    progress({ phase: 'copying' })
    signal?.throwIfAborted()
    await fs.copyFile(file, copy)
    if ((await fs.stat(copy)).size !== stat.size) throw Error('Incomplete installation input copy.')
    await assertOwnedPath(runtime.directory, log)
    await fs.mkdir(logDirectory, { recursive: true })
    try {
      await fs.rename(log, oldLog)
      savedLog = true
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    progress({ phase: 'installing' })
    let output = '',
      processError
    try {
      output = await run(
        runtime.executable,
        ['--headless', kind === 'firmware' ? '--installfw' : '--installpkg', resolve(copy)],
        { cwd: runtime.directory, env, signal }
      )
    } catch (error) {
      // Only a completed child exit may be reconciled with firmware on disk.
      // Spawn failures, timeouts and explicit cancellation must remain errors.
      if (kind !== 'firmware' || error.code !== 'RPCS3_INSTALL_EXIT') throw error
      processError = error
    }
    signal?.throwIfAborted()
    progress({ phase: 'verifying' })
    const checked = runtime.status()
    if (kind === 'firmware') {
      // RPCS3 may finish installing dev_flash and then crash during teardown.
      // Reuse the same version/system-module checks as the Ready status panel;
      // neither an exit code nor missing success text overrides valid firmware.
      if (checked.error === 'rpcs3_status_failed' || !checked.firmware.ready)
        throw (
          processError || Error('Firmware installation did not produce a valid installed firmware.')
        )
      progress({ phase: 'complete' })
      return { success: true, status: checked, titleId: null }
    }
    let logText = ''
    try {
      const handle = await fs.open(log, 'r')
      try {
        const st = await handle.stat()
        const bytes = Buffer.alloc(Math.min(st.size, 8 * 1024 * 1024))
        await handle.read(bytes, 0, bytes.length, Math.max(0, st.size - bytes.length))
        logText = bytes.toString('utf8')
      } finally {
        await handle.close()
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    const evidence = output + '\n' + logText
    const success = new RegExp('Successfully installed [^\\r\\n]+\\(title_id=' + title + ',').test(
      evidence
    )
    if (!success)
      throw Error(
        'RPCS3 did not confirm a successful installation. Check RPCS3.log; existing content was not treated as proof of success.'
      )
    if (kind === 'package') {
      const sfo = join(target, 'game', title, 'PARAM.SFO')
      await assertOwnedPath(runtime.directory, sfo)
      if (!(await header(sfo, 4)).equals(Buffer.from([0, 80, 83, 70])))
        throw Error('Installed package metadata is missing or invalid.')
    }
    progress({ phase: 'complete' })
    return { success: true, status: checked, titleId: title }
  } finally {
    // Restore the previous log only if RPCS3 never created a new one; never read it as evidence.
    if (savedLog && !(await fs.stat(log).catch(() => null))) await fs.rename(oldLog, log)
    await assertOwnedPath(dirname(runtime.directory), stage)
    await fs.rm(stage, { recursive: true, force: true })
  }
}
