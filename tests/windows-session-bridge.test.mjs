import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'

const source = fs.readFileSync(new URL('../resources/gamepad-bridge.ps1', import.meta.url), 'utf8')
const nativeBlock = /Add-Type -TypeDefinition @'\r?\n([\s\S]*?)\r?\n'@/
const windows = { skip: process.platform !== 'win32' }

// Execute the real PowerShell control loop with deterministic XInput/window APIs.
// No test foregrounds real applications or reads the user's controller.
function runScript(script) {
  // Match the production bridge invocation without modifying execution policy.
  return execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')
    ],
    {
      encoding: 'utf8',
      timeout: 20000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
}

test(
  'Windows bridge native declarations compile without invoking Win32 input APIs',
  windows,
  () => {
    const block = source.match(nativeBlock)
    assert(block)
    assert.deepEqual(
      runScript(`Add-Type -TypeDefinition @'\n${block[1]}\n'@\nWrite-Output 'compiled'`),
      ['compiled']
    )
  }
)

function simulate({ buttons, foreground, commands = {}, succeeds = true }) {
  const config = JSON.stringify({ pad: [8, 9], keys: [], zenithWindow: '12345', zenithPid: 9090 })
  const input = buttons.map((_, i) => commands[i] ?? (i === 0 ? config : null))
  const mock = `
using System;
public class TestClock { public long ElapsedMilliseconds { get { return ZenithPad.Frame * 100; } } }
public static class ZenithPad {
  public static int Frame = -1;
  static int[] Buttons = new int[] { ${buttons.join(',')} };
  static bool[] Foreground = new bool[] { ${foreground.join(',')} };
  static string[] Commands = new string[] { ${input.map((v) => (v === null ? 'null' : JSON.stringify(v))).join(',')} };
  public static void StartReader() {}
  public static string NextCommand() { Frame++; return Frame >= Buttons.Length ? "stop" : Commands[Frame]; }
  public static int Read(int slot) { return slot == 0 ? Buttons[Frame] : 0; }
  public static int GetAsyncKeyState(int key) { return 0; }
  public static bool IsForeground(int pid) { return Foreground[Frame]; }
  public static bool ShowWindow(IntPtr h, int n) { return true; }
  public static bool SetForegroundWindow(IntPtr h) { Console.WriteLine("resume-focus"); return true; }
  public static bool FocusZenith(long hwnd, int pid) { Console.WriteLine("focus:" + hwnd + ":" + pid); return ${succeeds}; }
}
`
  const script = source
    .replace('param([int]$EmulatorPid)', '$EmulatorPid = 7007')
    .replace(nativeBlock, `Add-Type -TypeDefinition @'\n${mock}\n'@`)
    .replace('[System.Diagnostics.Stopwatch]::StartNew()', '[TestClock]::new()')
  return runScript(`
$fakeEmulator = [pscustomobject]@{ MainWindowHandle = [IntPtr]42 }
$fakeEmulator | Add-Member -MemberType ScriptMethod -Name Refresh -Value {}
function Get-Process { param($Id, $ErrorAction) return $fakeEmulator }
function Start-Sleep { param($Milliseconds) }
${script}`)
}

test(
  'View+Menu survives a Steam foreground race, opens once, and waits for release on resume',
  windows,
  () => {
    const output = simulate({
      buttons: [0, 0x30, 0x30, 0x30, 0x30, 0, 0x30],
      foreground: [true, false, false, false, true, true, true],
      commands: { 2: 'focus-zenith', 3: 'resume' }
    })
    assert.equal(output.filter((v) => v === 'home').length, 2)
    assert.equal(output.filter((v) => v === 'focus:12345:9090').length, 3)
    assert.equal(output.filter((v) => v === 'resume-focus').length, 1)
  }
)

test('bridge ignores unrelated desktop input and a single chord button', windows, () => {
  assert.deepEqual(simulate({ buttons: [0, 0x30], foreground: [false, false] }), [])
  assert.deepEqual(simulate({ buttons: [0, 0x20, 0x10], foreground: [true, true, true] }), [])
  assert.deepEqual(
    simulate({
      buttons: [0, 0, 0, 0, 0, 0, 0, 0x30],
      foreground: [true, false, false, false, false, false, false, false]
    }),
    []
  )
})

test('native foreground retries are bounded when Windows rejects activation', windows, () => {
  const output = simulate({
    buttons: [0, 0x30, 0x30, 0x30, 0x30, 0x30],
    foreground: [true, true, true, true, true, true],
    succeeds: false
  })
  assert.equal(output.filter((v) => v === 'home').length, 1)
  assert.equal(output.filter((v) => v === 'focus:12345:9090').length, 3)
})
