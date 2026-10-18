import fs from 'node:fs/promises'
import { join } from 'node:path'

/** Diagnose only evidence-backed failures; access violations alone do not prove GPU failure. */
export function classifyCrash({ code, signal, output = '', error = '' }) {
  const text = output + '\n' + error
  const unsignedCode = Number.isInteger(code) ? code >>> 0 : null
  const reason =
    /VK_ERROR_DEVICE_LOST|DXGI_ERROR_DEVICE_(REMOVED|HUNG|RESET)|device lost|driver crash/i.test(
      text
    )
      ? 'gpu_driver'
      : /out of (device |video |gpu )?memory|VK_ERROR_OUT_OF|bad_alloc/i.test(text)
        ? 'memory'
        : /missing.*dll|cannot.*shared object|module.*not.*found/i.test(text) ||
            unsignedCode === 0xc0000135
          ? 'missing_library'
          : 'emulator_crash'
  return {
    reason,
    code: unsignedCode,
    signal: signal || null,
    codeHex: unsignedCode === null ? null : '0x' + unsignedCode.toString(16).padStart(8, '0')
  }
}

/** Bounded, serialized local diagnostics. Logging failure must not block window recovery. */
export function createCrashReporter({ userData }) {
  let queue = Promise.resolve()
  const directory = join(userData, 'logs'),
    file = join(directory, 'crash-report.log')
  return {
    record(details) {
      queue = queue
        .catch(() => {})
        .then(async () => {
          await fs.mkdir(directory, { recursive: true })
          for (const target of [directory, file, file + '.1']) {
            const stat = await fs.lstat(target).catch(() => null)
            if (stat?.isSymbolicLink()) throw Error('Linked crash log rejected')
          }
          const stat = await fs.stat(file).catch(() => null)
          if (stat?.size > 1024 * 1024) {
            await fs.rm(file + '.1', { force: true })
            await fs.rename(file, file + '.1')
          }
          await fs.appendFile(
            file,
            JSON.stringify({
              at: new Date().toISOString(),
              ...details,
              output: String(details.output || '').slice(-16384)
            }) + '\n',
            { mode: 0o600 }
          )
        })
        .catch((error) => {
          console.warn('[Crash report]', error.message)
        })
      return queue
    }
  }
}

/** One terminal notification across error/exit/close; keep only a small diagnostic tail. */
export function watchEmulator(child, { label, reporter, hardware, finish }) {
  let done = false,
    output = ''
  const capture = (chunk) => {
    output = (output + chunk.toString()).slice(-16384)
  }
  child.stdout?.on('data', capture)
  child.stderr?.on('data', capture)
  const settle = (code, signal, error) => {
    if (done) return
    done = true
    const failure = error || (code !== 0 && !child.killed)
    if (!failure) {
      finish(null)
      return
    }
    const diagnostic = classifyCrash({ code, signal, error: error?.message, output })
    void reporter.record({
      emulator: label,
      ...diagnostic,
      output,
      error: error?.message,
      hardware
    })
    finish({ ...diagnostic, emulator: label })
  }
  child.once('error', (error) => settle(null, null, error))
  child.once('exit', (code, signal) => settle(code, signal))
  child.once('close', (code, signal) => settle(code, signal))
  return { fail: (error) => settle(null, null, error) }
}
