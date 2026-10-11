# Windows background XInput and key-state reader. No admin rights or registry changes.
param([int]$EmulatorPid)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Collections.Concurrent;
using System.Threading;
public static class ZenithPad {
  static readonly ConcurrentQueue<string> Commands = new ConcurrentQueue<string>();
  public static void StartReader() { var thread = new Thread(() => { string line; while ((line = Console.ReadLine()) != null) Commands.Enqueue(line); Commands.Enqueue("stop"); }); thread.IsBackground = true; thread.Start(); }
  public static string NextCommand() { string line; return Commands.TryDequeue(out line) ? line : null; }
  [StructLayout(LayoutKind.Sequential)] public struct State { public uint packet; public ushort buttons; public byte lt, rt; public short lx,ly,rx,ry; }
  [DllImport("xinput1_4.dll", EntryPoint="#100")] static extern uint Read4(uint index, out State state);
  [DllImport("xinput1_3.dll", EntryPoint="#100")] static extern uint Read3(uint index, out State state);
  [DllImport("xinput1_4.dll", EntryPoint="XInputGetState")] static extern uint ReadStandard(uint index, out State state);
  public static int Read(uint index) { State s; uint result; try { result=Read4(index,out s); } catch { try { result=Read3(index,out s); } catch { try { result=ReadStandard(index,out s); } catch { return 0; } } } return result==0 ? s.buttons | (s.lt>128?0x10000:0) | (s.rt>128?0x20000:0) : 0; }
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  public static bool IsForeground(int pid) { uint owner; GetWindowThreadProcessId(GetForegroundWindow(), out owner); return owner == pid; }
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int n);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  public static void HoldMask(long handle, int pid) {
    uint owner; var h = new IntPtr(handle);
    if (handle != 0 && GetWindowThreadProcessId(h, out owner) != 0 && owner == (uint)pid)
      SetWindowPos(h, new IntPtr(-1), 0, 0, 0, 0, 0x0013); // TOPMOST, no move/size/activate
  }
  delegate bool EnumProc(IntPtr h, IntPtr parameter);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr parameter);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, System.Text.StringBuilder text, int capacity);
  // Compilation dialogs and the zero-FPS initial surface never satisfy readiness.
  public static bool RenderReady(int pid) {
    bool ready = false;
    EnumWindows((h, p) => {
      uint owner; GetWindowThreadProcessId(h, out owner);
      if (owner != (uint)pid || !IsWindowVisible(h)) return true;
      var title = new System.Text.StringBuilder(2048); GetWindowText(h, title, title.Capacity);
      var match = System.Text.RegularExpressions.Regex.Match(title.ToString(), @"^FPS:\s*([0-9]+(?:[.,][0-9]+)?)\s*\|");
      double fps;
      if (match.Success && double.TryParse(match.Groups[1].Value.Replace(',', '.'), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out fps) && fps > 0) ready = true;
      return !ready;
    }, IntPtr.Zero);
    return ready;
  }
  // Only activate the exact Zenith HWND supplied by Main; never foreground an arbitrary process.
  public static bool FocusZenith(long handle, int pid) {
    var window = new IntPtr(handle);
    uint owner;
    if (handle == 0 || pid <= 0 || GetWindowThreadProcessId(window, out owner) == 0 || owner != (uint)pid) return false;
    ShowWindowAsync(window, 5);
    return SetForegroundWindow(window);
  }
}
'@
$held = $false
$awaitRelease = $false
$padKeys = @(8,9)
$keyCodes = @()
$zenithWindow = 0L
$zenithPid = 0
$overlayOpen = $false
$watchReady = $false
$readySent = $false
$lastReadyCheck = -1000L
$readySamples = 0
$focusAttempts = 0
$clock = [System.Diagnostics.Stopwatch]::StartNew()
$lastEmulatorForeground = -10000L
$buttonMasks = @(0x1000,0x2000,0x4000,0x8000,0x100,0x200,0x10000,0x20000,0x20,0x10,0x40,0x80,1,2,4,8,0x400)
[ZenithPad]::StartReader()
while ($true) {
  try { $emulator = Get-Process -Id $EmulatorPid -ErrorAction Stop } catch { break }
  $command = [ZenithPad]::NextCommand()
  if ($null -ne $command) {
    if ($null -eq $command -or $command -eq 'stop') { break }
    if ($command.StartsWith('{')) {
      try {
        $config = $command | ConvertFrom-Json
        $watchReady = [bool]$config.watchReady
        $padKeys = @($config.pad); $keyCodes = @($config.keys)
        $zenithWindow = [long]$config.zenithWindow; $zenithPid = [int]$config.zenithPid
      } catch { }
    }
    if ($command -eq 'focus-zenith') {
      $overlayOpen = $true
      $focusAttempts = 3
    }
    if ($command -eq 'resume') {
      $overlayOpen = $false
      $focusAttempts = 0
      $awaitRelease = $true
      $emulator.Refresh()
      [void][ZenithPad]::ShowWindow($emulator.MainWindowHandle,9)
      [void][ZenithPad]::SetForegroundWindow($emulator.MainWindowHandle)
    }

  }
  $emulatorForeground = [ZenithPad]::IsForeground($EmulatorPid)
  if ($watchReady -and -not $readySent -and ($clock.ElapsedMilliseconds - $lastReadyCheck -ge 250)) {
    $lastReadyCheck = $clock.ElapsedMilliseconds
    [ZenithPad]::HoldMask($zenithWindow, $zenithPid)
    if ($emulatorForeground) { [void][ZenithPad]::FocusZenith($zenithWindow, $zenithPid) }
    if ([ZenithPad]::RenderReady($EmulatorPid)) {
      $readySamples++
    } else { $readySamples = 0 }
    if ($readySamples -ge 3) {
      $readySent = $true
      [Console]::WriteLine('ready')
      [Console]::Out.Flush()
    }
  }
  if ($emulatorForeground) { $lastEmulatorForeground = $clock.ElapsedMilliseconds }
  $down = $false
  for ($slot=0; $slot -lt 4; $slot++) {
    $buttons = [ZenithPad]::Read($slot)
    $combo = $padKeys.Count -eq 2
    foreach ($key in $padKeys) { if ($key -lt 0 -or $key -gt 16 -or ($buttons -band $buttonMasks[$key]) -eq 0) { $combo = $false } }
    if ($combo -or ($buttons -band 0x0400) -ne 0) { $down = $true }
  }
  $keyboardCombo = $keyCodes.Count -eq 2
  foreach ($key in $keyCodes) { if (([ZenithPad]::GetAsyncKeyState($key) -band 0x8000) -eq 0) { $keyboardCombo = $false } }
  if ($keyboardCombo -or ([ZenithPad]::GetAsyncKeyState(27) -band 0x8000) -ne 0 -or ([ZenithPad]::GetAsyncKeyState(121) -band 0x8000) -ne 0) { $down = $true }
  # The Escape that closes Zenith must be released before it can reopen the menu.
  if ($awaitRelease) {
    if (-not $down) { $awaitRelease = $false }
    $held = $down
    Start-Sleep -Milliseconds 20
    continue
  }
  # XInput polling observes input; it cannot consume Steam's independent desktop bindings.
  # A short foreground grace handles Steam taking focus between the chord and this poll.
  # Outside that grace, do not steal focus from other desktop applications.
  $recentEmulator = $emulatorForeground -or ($clock.ElapsedMilliseconds - $lastEmulatorForeground -le 500)
  if ($down -and -not $held -and -not $overlayOpen -and $recentEmulator) {
    $overlayOpen = $true
    $focusAttempts = 3
    [Console]::WriteLine('home')
    [Console]::Out.Flush()
  }
  if ($focusAttempts -gt 0) {
    $focusAttempts--
    if ([ZenithPad]::FocusZenith($zenithWindow, $zenithPid)) { $focusAttempts = 0 }
    elseif ($focusAttempts -eq 0) { [Console]::Error.WriteLine('Zenith foreground request was denied by Windows.') }
  }
  $held = $down
  Start-Sleep -Milliseconds 20
}
