# RPCS3 integration plan

Branch: `feat/rpcs3-integration`. This document separates platform recognition from
standalone emulator installation and launch. Stages 1–3 are implemented for Windows x64 bootstrap, standalone launch and
user-selected firmware/package installation and automatic installed-title discovery.
Complete external disc-folder import remains separate work.

## Stage 1 — Platform definitions and safe recognition (implemented)

| File                                                   | Change                                                                                                                                                    |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/shared/consoles.js`                               | Register PS3 `.iso`, `.pkg`, `.bin`; define disc `PS3_GAME/USRDIR/EBOOT.BIN` and installed `USRDIR/EBOOT.BIN` layouts; export shared path classification. |
| `src/main/index.js`                                    | Use shared classification for flat library scanning. Dispatch PS3 to the standalone RPCS3 pipeline before RetroArch preparation/core selection.           |
| `src/main/services/libraryStore.js`                    | Apply the same classification to persisted imports; avoid duplicate extension maps with conflicting ISO defaults.                                         |
| `src/main/services/gameImporter.js`                    | Preserve a PS3 directory hint as `(PS3)` when copying an ISO into the central library. Refuse standalone EBOOT copying, which would lose dependent files. |
| `.gitignore`                                           | Exclude PS3 packages, firmware, licenses, executable images and runtime directories in mixed case. Existing `emulators/*` excludes RPCS3 installations.   |
| `tests/ps3-platform.test.mjs`, `tests/local-games.cjs` | Cover shared extension collisions, picker filters, import persistence, EBOOT layouts, Git protection and the staged launch boundary.                      |

Recognition rules:

- Manual platform selection takes precedence. Otherwise an ISO with a PS3/PlayStation 3
  filename or path hint is PS3; bounded disc inspection recognizes PS3_GAME, PSP_GAME,
  PS3 system headers and PS2/PS1 SYSTEM.CNF. Unrecognized ISOs default to PS3 after
  remaining PSP/PS2 filename hints. The filesystem-free shared detector only supplies
  hints; Main's discInspector.js and libraryStore.platformFor decide the final platform.
- PKG is a PS3 installation **candidate**. Extension matching does not validate
  package contents or imply that an update/DLC/package can be booted directly.
- Only an EBOOT path matching a defined USRDIR layout is recognized as PS3. Generic
  BIN and a standalone EBOOT.BIN remain unassigned. PSP's SYSDIR layout is distinct.
- Shared classifiers are filesystem-independent and handle both path separators.
  The eventual folder scanner must validate actual files and preserve native case.
- The existing picker receives PKG automatically through the shared extension list.
  The existing renderer console filter receives PS3 from the same registry.
- Flat scanning and ISO/PKG file import work in this stage. Recursive folder discovery,
  complete folder import remain pending. Stages 2–3 below add execution and installation.

## Stage 2 — Standalone launch and status (implemented slice)

### Runtime layout and manual preparation

All paths are resolved in Main; development and packaged builds use the same layout:

```text
userData/emulators/rpcs3/
  rpcs3.exe                  # Windows: complete upstream installation, not only this file
  rpcs3                      # Linux: executable x86-64 binary/AppImage with this name
  portable/                  # Created before status/launch; RPCS3's portable profile
    config/vfs.yml           # Windows VFS settings (Linux: portable/vfs.yml)
    dev_flash/               # Installed firmware, NOT a downloaded PUP placeholder
    dev_hdd0/                # RPCS3-owned installed titles, saves and user state
```

1. Open the RPCS3 setup/status panel. On Windows x64, choose Download RPCS3 and
   confirm the official download. Linux continues to use manual installation of the
   complete upstream runtime in the displayed directory.
2. Select your legally obtained Sony PS3UPDAT.PUP with Install PS3 Firmware. Zenith
   copies the input to private staging and invokes the official headless installer.
3. Wait for verified Ready status, then retry the selected game. Import a supported
   PS3 ISO with a PS3 name/path hint. Validity and compatibility remain RPCS3's responsibility.
4. Install PKG (or Add Game with a PKG) installs the user-selected input and refreshes
   the library automatically. Bootable installed titles appear by their PARAM.SFO name;
   data-only packages do not become game cards. A PKG itself is never a boot target.

### Implementation and session lifecycle

| File                                                     | Implemented responsibility                                                                                                                                                                      |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| src/main/services/rpcs3Runtime.js                        | Own paths; bounded executable/firmware probes; parse bounded VFS YAML with js-yaml JSON_SCHEMA; return structured status and shell-free launch plans.                                           |
| src/main/index.js                                        | Authorize PS3 against the library, bypass RetroArch preparation/core/BIOS paths, call shared runEmulatorSession. Register status/folder IPC and reject Libretro selection/installation for PS3. |
| src/main/services/sessionBridge.js                       | Reused unchanged: pass the actual RPCS3 child PID and Zenith HWND to the native helper.                                                                                                         |
| resources/gamepad-bridge.ps1                             | Reused unchanged: PID-based XInput/keyboard monitoring, View+Menu or configured chord, native focus request, resume and shutdown. No process-name matching.                                     |
| src/preload/index.js                                     | Expose getRpcs3Status() and openRpcs3Folder(); launchGame(gamePath, consoleType) remains compatible.                                                                                            |
| src/renderer/src/components/Rpcs3Status.jsx              | Executable/firmware diagnostics, installation paths, folder action, fresh recheck, optional retry of the same game.                                                                             |
| src/renderer/src/App.jsx / components/SystemSettings.jsx | Recoverable launch setup modal and standalone PS3 status card. No misleading core download/BIOS button.                                                                                         |
| src/renderer/src/locales/en.json / tr.json               | Localized setup/errors; session copy does not promise automatic RPCS3 pausing.                                                                                                                  |
| tests/rpcs3.test.mjs / tests/rpcs3-launcher.cjs          | Synthetic filesystem tests and real Electron IPC/React tests with mocked child/bridge processes.                                                                                                |

Launch sequence: library authorization → physical runtime/firmware check →
`spawn(absoluteExecutable, ['--no-gui', absoluteGamePath], {cwd: runtimeDirectory,
shell: false, detached: true})` → game-started → hide Zenith → bridge with child.pid.
On Linux, inherited Zenith AppImage identity variables are removed and shader/log cache
is directed below the RPCS3 runtime. RPCS3's portable profile controls firmware/VFS.

View+Menu → bridge home event → openSessionMenu → kiosk/fullscreen, always-on-top,
show/focus, native HWND activation → renderer session dialog with initial Resume focus.
Resume releases always-on-top, hides Zenith and asks the bridge to restore emulator
focus. Stop kills the owned process. Exit/error/close finalization runs once, stops the
bridge, unregisters session shortcuts, restores Zenith and resolves the pending launch
Promise. RetroArch and RPCS3 share the duplicate-session guard and lifecycle.

### IPC/status contract

| Channel / preload API                      | Payload                     | Result / behavior                                                                                                                                                |
| ------------------------------------------ | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| get-rpcs3-status / getRpcs3Status()        | none                        | {emulator, platform, directory, executable, configDirectory, executableReady, firmware:{ready,directory,version}, ready, error, message?}; fresh physical check. |
| open-rpcs3-folder / openRpcs3Folder()      | none                        | {success,error?}; create owned portable skeleton and open the fixed runtime directory. Arbitrary renderer paths are never accepted.                              |
| get-system-status / getSystemStatus()      | none                        | Existing RetroArch entries unchanged. PS3 entry is {platform:'PS3',emulator:'RPCS3',runtime:status}, not a libretro core record.                                 |
| launch-game / launchGame(path,'PS3')       | existing library path + PS3 | Setup failure: {success:false,error,platform:'PS3',status?}. Successful spawn retains the pending Promise until process exit.                                    |
| game-started / game-stopped / session-menu | existing events             | Existing contracts preserved; both emulators share them.                                                                                                         |
| get-runtime-info                           | none                        | Adds rpcs3Directory to existing diagnostics.                                                                                                                     |

Failure codes: missing_rpcs3, missing_ps3_firmware, rpcs3_status_failed,
unsupported_rpcs3_host, ps3_game_missing, ps3_invalid_game, ps3_package_not_installed.
No child is spawned on these results. Unexpected spawn/exit failures follow the existing
visible launch-error path and release the launch lock.

Readiness requires a nonempty Windows x64 PE or Linux x64 ELF executable (plus Linux
execute permission), an installed dev_flash/vsh/etc/version.txt release marker, and a
nonempty sys/external/liblv2.sprx SELF header. Custom VFS firmware/emulator directories
are resolved before checking. Malformed/oversized VFS configuration returns an error.
These are structural installation checks, not cryptographic authenticity, full firmware
integrity, OS dependency, graphics driver or game compatibility verification.

### Explicit remaining work and validation limits

- Complete folder import/discovery with PARAM.SFO validation and owned-root deletion.
  A previously registered intact EBOOT path can boot, but importing only EBOOT is still
  refused so dependent files are not lost.
- Complete removal of installed RPCS3 game trees remains separate from library exclusion.
- Real RPCS3/controller hardware and Linux/Steam Deck smoke tests. Automated tests use
  synthetic files and mocked emulator processes; they do not prove game compatibility.
- Automatic pause behind the session overlay is not implemented for RPCS3. Session
  focus controls work independently; no RetroArch pause/session.cfg flags are applied.

Run `npm run test:rpcs3` (Windows Electron harness), `node --test tests/*.test.mjs`,
and the existing launcher/hotkeys/local-games Electron regression tests.

## Stage 3 — On-demand bootstrap and content installation (implemented)

### Services and download trust boundary

- **src/main/services/rpcs3Download.js** discovers the latest Windows x64 MSVC
  archive through https://api.github.com/repos/RPCS3/rpcs3-binaries-win/releases/latest.
  It accepts only the fixed official repository and approved HTTPS GitHub asset redirects.
  A missing upstream SHA-256 digest fails closed. No API token is required; rate-limit
  or connection errors are displayed without reporting a successful installation.
- Streaming downloads verify the exact advertised size and SHA-256. Metadata has a
  15-second deadline and 2 MiB limit; the entire job has a 10-minute deadline;
  archives are capped at 200 MiB, expanded content at 2 GiB and 20,000 entries.
- The packaged 7zip-bin helper lists entries, tests archive integrity, then extracts
  into a private sibling staging directory. Each command has a 120-second timeout.
  Malformed paths, duplicates, junctions, symlinks, hardlinks and Windows device/ADS
  names are rejected. Safe profile/firmware entries (including
  `config`, `config.yml`, `portable` and `dev_hdd0`) are skipped. An exact UTF-8
  7-Zip include list extracts only `.exe`/`.dll` files outside those trees, with
  wildcard matching disabled; this applies to initial installs and updates.
  Skipped entries never reach staging or the live runtime. Extracted types/sizes
  and x64 PE are checked.
- Only newly verified downloads have their NTFS Zone.Identifier stream removed;
  other stream-removal errors fail the operation. System security policy and existing
  manually installed binaries are untouched.
- Files are published below userData/emulators/rpcs3; the executable is published last.
  Replaced binary files are backed up and restored on failure. The portable profile
  is preserved. If rollback itself fails, recovery files are retained and their path
  appears in the error. This is not a crash-proof directory transaction.

### Firmware / package installer

**src/main/services/rpcs3Content.js** validates bounded input headers (SCEUF PUP,
PS3 PKG content ID), copies the selected input asynchronously to private staging,
and runs the existing runtime with shell:false and windowsHide:true:

```text
rpcs3.exe --headless --installfw <absolute-staged-PUP>
rpcs3.exe --headless --installpkg <absolute-staged-PKG>
```

The official switches are **--installfw / --installpkg**, not --install-firmware /
--install-pkg. Upstream rejects installation in --no-gui mode. No terminal prompts,
license acquisition, decryption or firmware downloading are implemented.

Firmware success is determined by a physical dev_flash recheck after the child
closes: a valid release marker and required system module mean success even when
RPCS3 crashes during teardown (for example, exit code 3221226505), or emits no
success log. Missing/invalid firmware is still an error, including after exit zero.
Spawn errors, timeouts and explicit cancellation are not treated as successful installs.
PKG retains its stricter requirement: zero exit, fresh title-specific success output
and an installed PARAM.SFO header. The old RPCS3.log is moved aside before execution.
Logs remain in portable/log on Windows;
Linux uses runtime/cache/rpcs3. PUP inputs are capped at 2 GiB, PKG at 64 GiB;
installation times out after 30 minutes. Private input copies are cleaned up,
and the user's original input is never modified. Existing installed content may
be updated by RPCS3; cancellation/failure is not a rollback of firmware or packages.
Recheck and retry after a partial installation. No optimistic Ready flag is stored.

The runtime's portable VFS determines dev_flash/dev_hdd0. Installation rejects
paths outside the managed runtime or through links, even though read-only status
can inspect a manually configured external VFS. Launch and all maintenance jobs
are serialized by Main. Quit cancels maintenance and waits for its cleanup.

### IPC additions

| Channel / preload API                                     | Payload             | Result / behavior                                                                                                                                           |
| --------------------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| download-rpcs3 / downloadRpcs3(confirmed=false)           | {confirmed:boolean} | Without explicit true: {success:false,canceled:true}. With consent: verified download, {success:true,status,version?}; errors {success:false,error,status}. |
| install-ps3-firmware / installPs3Firmware(token)          | firmware-purpose browser token | In-app PUP selection, headless installation, {success:true,status,titleId:null}; picker cancellation sends no install IPC; errors remain visible. |
| install-ps3-package / installPs3Package(token)                 | none                | In-app PKG browser token, header/title checks and headless install; {success:true,status,titleId}. Refreshes installed titles and sends library-changed.           |
| cancel-rpcs3-install / cancelRpcs3Install()               | none                | Abort the single maintenance job; child exit and cleanup release the lock.                                                                                  |
| rpcs3-install-progress / onRpcs3InstallProgress(callback) | Main event          | {phase,received?,total?} or null when idle; preload returns unsubscribe.                                                                                    |
| get-rpcs3-status                                          | none                | Adds hostPlatform and operation to the physical runtime status.                                                                                             |

**Rpcs3Status.jsx** is shared by launch recovery and System Settings. It offers explicit
inline download consent, progress, in-app PUP/PKG browser, cancel, errors, recheck
and an optional Launch button after readiness. Actions are disabled during a job.
Closing the panel does not cancel an active job; reopening reads its operation status.
No renderer-supplied executable, install path, URL or shell command is accepted.

### Packaging and verification

RPCS3, PUP/PKG, per-title licenses, firmware trees and PS3 games remain excluded from
Git and electron-builder files/extraResources, including mixed-case input extensions.
No RPCS3 extraResources entry exists. 7zip-bin is a production extraction helper,
unpacked from ASAR; its notices are under resources/licenses. It is not an emulator.
The Git-index guard also rejects renamed PUP/PKG/SELF signatures. An ignore rule alone
is not a license or proof about existing release artifacts.

- tests/rpcs3-install.test.mjs: real synthetic 7z extraction, hash/redirect/path checks,
  rollback, MOTW failures, cancellation/timeouts, fresh firmware and PKG evidence.
- tests/rpcs3-launcher.cjs: real Electron/preload/React with fake child processes;
  consent, failed download, canceled picker, firmware success, false-success rejection,
  maintenance serialization and the existing PID/focus/session regression coverage.
- tests/distribution.test.mjs: forced tracked mixed-case PS3 inputs and renamed binaries.

No real firmware, commercial game, or downloaded RPCS3 binary is a fixture. A real
hardware/firmware installation smoke test and installer artifact audit are separate
from these automated checks. Existing stage-2 Linux launch support remains; automatic
runtime download is intentionally Windows x64 only.

## Installed title discovery

src/main/services/rpcs3Library.js scans the runtime-owned dev_hdd0/game/<TITLE_ID>
folders on startup and every library scan. It parses bounded PARAM.SFO tables,
checks matching TITLE_ID and bootable HG/DG categories, and requires a regular,
nonempty USRDIR/EBOOT.BIN. Missing, malformed, linked or external-VFS content and
GD data/update entries are skipped individually. The SFO title and optional ICON0.PNG
are used for display; stable title/path identities prevent duplicate cards or caches.

Both install-ps3-package and add-games PKG selections use installRpcs3AndRefresh.
Successful installation registers a valid matching EBOOT and sends library-changed.
The preload subscription triggers useGameLibrary.refresh(false), including background
scraping. PKG inputs are not copied into the central games folder. A rescan also
finds titles installed directly with RPCS3, without requiring a prior library record.
The launch pipeline passes the installed absolute EBOOT path to --no-gui.

Tests: tests/rpcs3-library.test.mjs and the expanded tests/rpcs3-launcher.cjs.
See ARCHITECTURE.md for fields, ownership restrictions and deletion semantics.

## Upstream references

- [RPCS3 quickstart](https://rpcs3.net/quickstart)
- [RPCS3 boot implementation](https://github.com/RPCS3/rpcs3/blob/master/rpcs3/Emu/System.cpp)
- [RPCS3 firmware/package UI](https://github.com/RPCS3/rpcs3/blob/master/rpcs3/rpcs3qt/main_window.cpp)

Upstream CLI/profile behavior was checked while implementing the stage 2 slice.
Recheck these interfaces when updating the supported RPCS3 distribution.

- [RPCS3 CLI implementation](https://github.com/RPCS3/rpcs3/blob/master/rpcs3/rpcs3.cpp)
- [RPCS3 portable/config directory resolution](https://github.com/RPCS3/rpcs3/blob/master/Utilities/File.cpp)
- [RPCS3 VFS mapping](https://github.com/RPCS3/rpcs3/blob/master/rpcs3/Emu/vfs_config.cpp)

## Controller defaults and compilation cache preparation

`src/main/services/rpcs3Config.js` runs inside `rpcs3Runtime.prepareLaunch`, after
physical setup checks and before the emulator is spawned. On current Windows
RPCS3 builds it merges `portable/config/config.yml`; on Linux it merges
`portable/config.yml`. A legacy Windows root config seeds the new file if needed.
No new IPC is needed. Parse/write failures return `rpcs3_config_failed` through
`launch-game` and display a localized error rather than a misleading Ready panel.

```yaml
Core:
  PPU Decoder: Recompiler (LLVM)
  LLVM Precompilation: true
  SPU Decoder: Recompiler (LLVM)
  SPU Cache: true
Video:
  Shader Mode: Async Recompiler (multi-threaded)
  Disable On-Disk Shader Cache: false
```

These names match RPCS3's [configuration schema](https://github.com/RPCS3/rpcs3/blob/master/rpcs3/Emu/system_config.h)
and [serialized enum values](https://github.com/RPCS3/rpcs3/blob/master/rpcs3/Emu/system_config_types.cpp).
PPU caching is managed by the LLVM recompiler; there is no invented `PPU Cache`
setting. The launcher leaves compiled files in place across sessions. Loading
cached modules still takes time, and new game content, emulator versions or GPU
drivers can require compilation again. Per-title settings remain authoritative
and are intentionally not rewritten.

On Windows the active global input profile is resolved from
`portable/config/input_configs/active_input_configurations.yml`. If that profile
is absent, `global/Default.yml` is used, matching RPCS3's fallback. Only a missing,
Null or Keyboard Player 1 handler is migrated to `XInput` / `XInput Pad #1`, with
complete Xbox button/stick bindings. The PS button uses Guide alone, leaving
View+Menu to Zenith's existing bridge. Existing controller mappings, other
players and per-title input overrides are preserved. No Sony hardware detection
is claimed: a configured DualShock/DualSense handler stays intact; a different
controller or XInput slot can be selected in RPCS3. Linux input profiles remain
untouched because XInput is Windows-specific.
See the upstream [profile loader](https://github.com/RPCS3/rpcs3/blob/master/rpcs3/Emu/Io/pad_config.cpp)
and [XInput implementation](https://github.com/RPCS3/rpcs3/blob/master/rpcs3/Input/xinput_pad_handler.cpp).

Writes are bounded, refuse linked configuration paths and use atomic temporary
publication. A first-change `.zenith-backup` preserves original settings and
comments. Unchanged configurations are not rewritten. Existing rendering/audio
options survive the merge; malformed YAML is not reset. No firmware, binaries,
controller data or compiled game cache is added to the repository.

Validation: runtime unit tests cover first-launch creation, keyboard migration,
active/fallback profiles, preservation of custom mappings and other players,
legacy configuration migration, persistent cache sentinels, unchanged file
mtimes, Linux paths and failed writes. The Electron launcher test checks actual
on-disk configuration before its mocked RPCS3 child starts, and verifies that
invalid configuration prevents spawning. Actual controller hardware and repeat
launch timings still require an RPCS3 smoke test.

## PS3 media discovery and download permissions

Settings → Media & Downloads exposes four independent downloadCovers, downloadBackgrounds, downloadVideos
and downloadAudio switches, all defaulting to true. Explicit legacy disabled
preferences are preserved when upgrading. Main persists them under media in userData/zenith-preferences.json
before returning success; hotkey patches share the same atomic write queue.
get-media-preferences and save-media-preferences are exposed through preload.
Disabled kinds cannot issue search, metadata or binary requests, including manual
rescans. Active requests are aborted when their permission is revoked. Cached
media remains usable offline; preview playback/audio settings remain separate.

Artwork priority is GameTDB cover, HD online cache, Libretro cache, then embedded game artwork.
Folder/installed PKG records read ICON0.PNG and PIC1.PNG next to PARAM.SFO;
PIC0.PNG is an optional overlay. Folder titles use PARAM.SFO, never EBOOT.
ps3IsoMedia.js uses full 7-Zip e with -r and -ssc- to extract only ICON0.PNG,
PIC1.PNG and PARAM.SFO into a unique temporary directory inside the game's
userData cache. It does not use -so. Nonzero exit/header warnings are tolerated
only when individually validated members were produced. PNGs are bounded to
20 MiB, SFO to 1 MiB, and the process to 15 seconds. The temporary tree is always
cleaned up; final names are fixed by Main. Source identity avoids repeated extraction.

PS3 TITLE_ID comes from folder or ISO PARAM.SFO; ISO metadata is cached with its
source identity in embedded-title.json. GameTDB requests cover/US, cover/EN, then
cover/JA under https://art.gametdb.com/ps3/ for a validated product ID. JPEG frame
validation and a 20 MiB limit precede publishing cover-gametdb.jpg. This cover
has priority over other cached boxart; the cover download preference gates it.

The Libretro platform is Sony - PlayStation 3. Archive searches optional
PS3-scoped portrait boxart and fanart PNGs, ranks metadata dimensions, and
validates downloaded dimensions: portrait width >=600, landscape >=1920×1080.
4K candidates rank ahead of smaller ones. Files are cover-hd.png / fanart.png,
limited to 20 MiB. Availability is provider-dependent; no upscaling is implied.

Video discovery first requests metadata for sony-playstation-3-video-snaps and
SonyPlaystation3VideoSnaps directly. Missing/restricted/nonmatching items fall back
to normal discovery; provider availability is not assumed. Discovery accepts PS3 platform aliases and HQ/HD-labeled Video Snaps packs,
matching exact game titles or TITLE_ID filenames. Individual preview/gameplay
search remains a fallback. MP4s retain the 60-second/5 MiB bounds and are written
to preview.mp4; requests time out after 15 seconds. No media is bundled.

Q/Y → Search for media again passes {id,gameId,platform,title,path} to games:rescrape.
Main verifies all fields against its own library record before doing any work.
Allowed cover/background/video/audio kinds are queried again even with an existing cache, which
is replaced only after successful validation. Main validates library membership.
Background updates persist to games.json and reach React via game-media-updated,
including covers and fanart. Enabled cached music is also refreshed on explicit retry.

7zip-bin-full 26.3.1 supplies unmodified 7-Zip 26.03 for ISO/UDF (the existing
reduced 7za does not support these formats). electron-builder unpacks it outside
ASAR and preserves the utility DLL; emulator-core exclusions remain unchanged.
Notices and source links are in resources/licenses. No native helper binaries
are committed to Git. Tests include real extraction of a synthetic ISO plus
mocked Archive/CDN data and actual Electron Settings/preload/React interaction.

The explicit rescrape IPC waits for the selected game's preview jobs and returns
{success:true,game,warning}; it does not wait behind unrelated automatic downloads.
Duplicate same-game requests coalesce, and queued automatic work is superseded
without duplicate writes. Invalid identity returns {success:false,error}. The
renderer shows completion/errors and updates its card using versioned media URLs
(path + mtime + size), avoiding stale Chromium image/video cache entries.

[Scraper] terminal logs expose title/platform, four permissions, queried URLs,
HTTP/network errors, validation failures and successful paths. [7-Zip] logs
report ICON0/PIC1 extraction or misses. Cover/background cooldowns are separate.

## Title ID recovery, startup masking and binary updates

ISO extraction version 3 also reads PS3_DISC.SFB when PARAM.SFO is unavailable.
TITLE_ID values normalize whitespace, NUL padding and regional ID hyphens without
substituting another game's ID. GameTDB US/EN/JA covers take precedence over embedded
ICON0. Explicit rescrape refreshes the extraction; a newly recovered ID bypasses
an earlier unsuccessful cover lookup cooldown.

Windows startup keeps Zenith above compilation dialogs. The launch config enables
fullscreen, disables focus-loss pausing and PPU hints, and uses a known FPS title
format. The PID-bound PowerShell watcher emits `ready` only after a visible game
window reports positive FPS. Main then sends `game-started` and releases topmost
status. A late ready signal never closes an open session menu. F10/Escape/chord
and a 120-second fallback expose the session menu instead of trapping the user.
This is window-title readiness, not guaranteed visual content detection; custom
per-title overrides may require the manual fallback. Linux uses fullscreen/hint
configuration but does not use this Windows watcher.

The Download Center (`D` / `RT`) streams task status through `downloads:progress`.
`emulators:update` is serialized with launch/setup and updates only installed
cores plus Windows RPCS3. RPCS3 update mode replaces verified EXE/DLL files only;
portable data, dev_hdd0, firmware, saves and config are preserved. Failed publish
operations roll back. User application updates use the separate electron-updater
GitHub feed `aibrhmckr/zenith-os`, with explicit restart/install and differential
NSIS artifacts. No firmware or RPCS3 executable is included in source/releases.


## Managed input isolation and safe restart

The current configuration step also clears PS Button in global and per-title input
profiles, preserving other custom mappings. GSFrame/disableKbHotkeys=true in
GuiConfigs/CurrentSettings.ini disables game-window Home/Restart keyboard shortcuts.
Original edited files receive a .zenith-backup. Compilation and keyboard-mode hints
are disabled; game-requested system dialogs remain enabled.

On Windows, the startup watcher reasserts Zenith TOPMOST every 250ms and requires
three consecutive positive-FPS samples. Opening and dismissing Zenith's menu during
compilation never removes the mask prematurely. This is a window-title heuristic,
not a Vulkan first-frame hook; Linux has no equivalent native watcher yet.

restart-session uses stopForRestart to terminate the existing child and await close
plus launch cleanup before issuing a fresh --no-gui launch. It does not invoke the
RPCS3 internal restart shortcut. A ten-second shutdown timeout aborts the restart.
game-loading re-arms the renderer mask; epoch tracking isolates old launch callbacks.
The Electron regression test exercises two successive restarts and menu use before
readiness with synthetic processes, without launching a real game.

Install PKG now uses FileBrowser (kind package) and installPs3Package(token).
Main revalidates this one-use selection before installation. Add Game uses games
purpose tokens and shares the existing PKG installer. Firmware now uses the same
in-app browser with a separate `firmware` purpose and case-insensitive `.pup` filter.
Tokens cannot be interchanged between the two installers. This supersedes the
stage-3 native picker contract above.
