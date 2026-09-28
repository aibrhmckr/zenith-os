import fs from 'node:fs'
import { normalizeHotkeys, windowsKeyCode } from '../../shared/hotkeys.js'
import { join, dirname } from 'node:path'
import { spawn } from 'node:child_process'
export function startSessionBridge(pid, scriptPath, onHome, hotkeys) {
  if (
    !['win32', 'linux'].includes(process.platform) ||
    !Number.isInteger(pid) ||
    !fs.existsSync(scriptPath)
  )
    return null
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
  let buffer = ''
  child.stdout.on('data', (data) => {
    buffer += data.toString()
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop()
    for (const line of lines) if (line.trim() === 'home') onHome()
  })
  child.on('error', () => {})
  child.stdin.on('error', () => {})
  child.stderr.on('data', (data) => console.warn('[Gamepad bridge]', data.toString()))
  const update = (value) => {
    const config = normalizeHotkeys(value)
    if (!child.killed && child.stdin.writable)
      child.stdin.write(
        JSON.stringify({
          pad: config.gamepad,
          keys: process.platform === 'win32' ? config.keyboard.map(windowsKeyCode) : config.keyboard
        }) + '\n'
      )
  }
  update(hotkeys)
  return {
    update,
    resume: () => {
      if (!child.killed && child.stdin.writable) child.stdin.write('resume\n')
    },
    stop: () => {
      if (!child.stdin.destroyed) child.stdin.end('stop\n')
      child.kill()
    }
  }
}
