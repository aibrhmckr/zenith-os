const path = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')

const patched = Symbol.for('zenith.nsisProcessEnvironment')

// electron-builder's Windows WineVm branch also runs the temporary NSIS
// uninstaller generator. Keep Windows' system environment for that invocation.
function resilientNsisExec(exec, { env = process.env, wait = delay, log = console.warn } = {}) {
  return async function (file, args = [], options = {}, ...rest) {
    if (args.length || options.env?.__COMPAT_LAYER !== 'RunAsInvoker' || !/\.exe$/i.test(file)) {
      return exec.call(this, file, args, options, ...rest)
    }
    const normalized = { ...options, windowsHide: true, env: { ...env, ...options.env } }
    const pauses = [250, 750, 1500, 3000]
    for (let attempt = 0; ; attempt++) {
      try {
        return await exec.call(this, path.resolve(file), args, normalized, ...rest)
      } catch (error) {
        const transient =
          ['UNKNOWN', 'EBUSY', 'EPERM', 'EACCES'].includes(error.code) ||
          /spawn (?:UNKNOWN|EBUSY|EPERM|EACCES)\b/.test(error.message)
        if (!transient || attempt === pauses.length) throw error
        log(
          `[NSIS] Temporary executable unavailable; retry ${attempt + 1}/${pauses.length} in ${pauses[attempt]}ms (${error.code || 'spawn error'}).`
        )
        await wait(pauses[attempt])
      }
    }
  }
}

function configureNsisProcess() {
  if (process.platform !== 'win32') return
  // A build-process-only adapter: no changes to node_modules or system policy.
  const { WineVmManager } = require('app-builder-lib/out/vm/WineVm')
  const prototype = WineVmManager.prototype
  if (prototype[patched]) return
  if (typeof prototype.exec !== 'function') throw Error('Unsupported electron-builder WineVm API.')
  prototype.exec = resilientNsisExec(prototype.exec)
  prototype[patched] = true
}

module.exports = { configureNsisProcess, resilientNsisExec }
