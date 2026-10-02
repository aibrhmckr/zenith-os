import fs from 'node:fs'
import { normalizeHotkeys, windowsKeyCode } from '../../shared/hotkeys.js'
import { join, dirname } from 'node:path'
import { spawn } from 'node:child_process'
/**
 * Start the Windows XInput or Linux SDL2/X11 helper for a numeric emulator PID. Buffer stdout
 * events and send normalized hotkeys over stdin without interpolating user commands.
 *
 * @param {number} pid - Numeric emulator process ID watched by the native helper.
 * @param {string} scriptPath - Trusted bundled input-bridge script path.
 * @param {Function} onHome - Called when the native helper emits a complete home line.
 * @param {Object} hotkeys - Normalized gamepad indices and physical keyboard-code pair.
 * @param {Buffer} windowHandle - Main-process BrowserWindow HWND; never accepted from renderer input.
 */
export function startSessionBridge(pid, scriptPath, onHome, hotkeys, windowHandle) {
  if (
    !['win32', 'linux'].includes(process.platform) ||
    !Number.isInteger(pid) ||
    !fs.existsSync(scriptPath)
  )
    return null
  // Preserve 64-bit HWND precision across JSON/PowerShell with a decimal string.
  const zenithWindow =
    process.platform === 'win32' && Buffer.isBuffer(windowHandle)
      ? windowHandle.length === 8
        ? windowHandle.readBigUInt64LE().toString()
        : windowHandle.length === 4
          ? String(windowHandle.readUInt32LE())
          : '0'
      : '0'
  // Encode the fixed script, never shell-interpolate a filename, game title or user input.
  const script = fs
    .readFileSync(scriptPath, 'utf8')
    .replace('param([int]$EmulatorPid)', `$EmulatorPid = ${pid}`)
  // Native Python cannot read Electron's virtual ASAR filesystem.
  const linuxScript = join(
    dirname(scriptPath.replace(/([\\/])app\.asar(?=[\\/])/, '$1app.asar.unpacked')),
    'gamepad-bridge.py'
  )
  const child = spawn(
    process.platform === 'win32' ? 'powershell.exe' : 'python3',
    process.platform === 'win32'
      ? [
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(script, 'utf16le').toString('base64')
        ]
      : [linuxScript, String(pid)],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
  )
  /**
   * Retain partial stdout lines across chunks so split home messages are not lost or duplicated.
   */
  let buffer = ''
  child.stdout.on(
    'data',
    /**
     * Handle data events for startSessionBridge; lifecycle cleanup or a one-shot subscription controls how long this callback remains active.
     *
     * @param {*} data - Value supplied by the enclosing operation; interpreted in this callback's local scope.
     */
    (data) => {
      buffer += data.toString()
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop()
      for (const line of lines) if (line.trim() === 'home') onHome()
    }
  )
  child.on(
    'error',
    /**
     * Handle error events for startSessionBridge; lifecycle cleanup or a one-shot subscription controls how long this callback remains active.
     */
    () => {}
  )
  child.stdin.on(
    'error',
    /**
     * Handle error events for startSessionBridge; lifecycle cleanup or a one-shot subscription controls how long this callback remains active.
     */
    () => {}
  )
  child.stderr.on(
    'data',
    /**
     * Handle data events for startSessionBridge; lifecycle cleanup or a one-shot subscription controls how long this callback remains active.
     *
     * @param {*} data - Value supplied by the enclosing operation; interpreted in this callback's local scope.
     */
    (data) => console.warn('[Gamepad bridge]', data.toString())
  )
  /**
   * Send validated gamepad indices and host keyboard codes to the live helper; ignore an already
   * closed input pipe.
   *
   * @param {*} value - Input value being normalized, displayed, or committed by this helper.
   */
  const update = (value) => {
    const config = normalizeHotkeys(value)
    if (!child.killed && child.stdin.writable)
      child.stdin.write(
        JSON.stringify({
          pad: config.gamepad,
          keys:
            process.platform === 'win32' ? config.keyboard.map(windowsKeyCode) : config.keyboard,
          ...(process.platform === 'win32' ? { zenithWindow, zenithPid: process.pid } : {})
        }) + '\n'
      )
  }
  update(hotkeys)
  return {
    update,
    /** Request native activation after Electron has shown its kiosk window. */
    focusZenith: () => {
      if (process.platform === 'win32' && !child.killed && child.stdin.writable)
        child.stdin.write('focus-zenith\n')
    },
    /**
     * Tell the native helper to restore emulator focus after the Zenith session overlay closes.
     */
    resume: () => {
      if (!child.killed && child.stdin.writable) child.stdin.write('resume\n')
    },
    /**
     * Close the helper input and kill its process when the emulator session ends to prevent
     * background polling leaks.
     */
    stop: () => {
      if (!child.stdin.destroyed) child.stdin.end('stop\n')
      child.kill()
    }
  }
}
