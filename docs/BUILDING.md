# Development, Packaging, and Releases

Environment setup, platform requirements, NSIS packaging, and application updates.

[Project overview](../README.md) · [User guide](USER_GUIDE.md) · [Runtime reference](RUNTIME.md) · [Build and release guide](BUILDING.md)

## Contents

- [Recommended IDE Setup](#recommended-ide-setup)
- [Project Setup](#project-setup)
- [Windows, Linux, and Steam Deck](#windows-linux-and-steam-deck)
- [Developer Architecture and Distribution Checks](#developer-architecture-and-distribution-checks)
- [RetroArch Developer Bootstrap and Production Packaging](#retroarch-developer-bootstrap-and-production-packaging)
- [Windows NSIS Setup Wizard](#windows-nsis-setup-wizard)
- [Notifications and software updates](#notifications-and-software-updates)

## Recommended IDE Setup

- [VSCode](https://code.visualstudio.com/) + [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) + [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)

## Project Setup

### Install

Use Node.js **22.12.0 or newer** (CI uses Node 22) and npm. Electron's current
download and ZIP extraction tools require this minimum Node version.

The lockfile pins Electron and security overrides. Use `npm ci` for reproducible
installs. `source-map-js` is pinned to 1.2.2 and `http-cache-semantics` to 4.3.0.
The unpatched `sprintf-js` dependency is removed through `global-agent` 4.1.3.
electron-builder retains its compatible `@electron/get` 3.x downloader API;
Electron uses its official `@electron-internal/extract-zip` 1.0.5 package instead
of the unpatched `extract-zip` 2.x implementation. Do not restore the old dependency
chain just to satisfy a transitive version range.

Electron's installation downloader uses Fetch/Undici. For `npm ci` behind a proxy,
set `ELECTRON_GET_USE_PROXY=true` along with `HTTP_PROXY` / `HTTPS_PROXY` and,
if needed, `NO_PROXY`. electron-builder retains its Got-based proxy, timeout and
retry behavior for packaging downloads.

Security caveat: a clean npm audit is not proof that every upstream behavior is
safe. In `http-cache-semantics` 4.3.0, security-zeroed cookie responses can still
satisfy `max-stale` in an isolated policy test. Zenith does not enable Got's shared
HTTP response cache; its artifact cache uses checksum validation. Do not enable
shared HTTP caching for authenticated downloads without addressing that upstream
behavior. `tests/dependency-security.test.mjs` covers the actual packaging path.

```bash
npm ci
```

### Development

```bash
npm run dev
```

### Build

```bash
# For Windows
npm run build:win

# For macOS
npm run build:mac

# For Linux
npm run build:linux
```

The macOS command remains in the project scripts, but the bundled RetroArch
validation currently supports Windows and Linux only.

## Windows, Linux, and Steam Deck

- Windows: `npm run build:win` produces the classic NSIS setup wizard for x64.
- Linux: `npm run build:linux` produces AppImage and deb packages for x64. Build
  Linux artifacts on a Linux CI runner or host.
- Development uses `emulators/retroarch/retroarch.exe` on Windows or
  `emulators/retroarch/retroarch` on Linux.
- Linux stores games in `userData/games/`, including during development. Packaged
  Linux builds keep emulator directories under `app.getPath('userData')`, typically
  `~/.config/zenith/emulators/retroarch/retroarch`. Nothing is written to the AppImage
  mount directory.
- The Linux RetroArch executable must have execute permission. Windows DLLs cannot
  be loaded on Linux; the application downloads matching `.so` cores. Packaged
  applications prepare the bundled RetroArch runtime in `userData` on first launch.
- On Steam Deck, mark the AppImage as executable and add it to Steam as a non-Steam
  game. Use the standard Gamepad layout in Steam Input. SteamOS may reserve the
  Steam/Guide button. The Linux in-game bridge reads controller combinations when
  Python 3 and SDL2 are available; custom keyboard combinations require X11.
  Wayland or SteamOS desktop restrictions may prevent this background access.
  Escape/F10 fallbacks also depend on desktop global-shortcut support.
  Intercepting Steam/Guide is not guaranteed.
- Paths are constructed with `path.join` and `path.normalize`; filenames are
  case-sensitive on Linux. Local file URLs use `pathToFileURL`. The `game-media`
  and `game-cover` protocols serve only allowed files so the Vite development
  server can display local media without bypassing `file://` access restrictions.

`npm run test:platform` verifies Linux path, ELF, and BIOS behavior and Windows
portable paths in a mocked environment. Linux and Steam Deck hardware tests have
not been performed in this Windows development environment.

Game Options includes **Guide & Lore**, **Search media again**, **Change Platform**,
and **Delete game**, with initial focus on the guide. Its selected index is maintained separately from DOM focus, resets
when reopened, and is restored when window focus returns. B closes the panel and
returns focus to the associated card. The console filter lists only platforms
present in the library plus **All consoles**, with four-direction grid navigation.

`npm run test:import-hotkeys` verifies central imports and combination handling.
`npm run test:hotkeys` covers two-step assignment and cancellation, persistence,
dashboard and in-game menus, native bridge messages, and RetroArch session settings
using synthetic data.

The Add game filter includes Atari `.a26`/`.a78`/`.lnx`, `.smd`/`.v64`, and
`.bin`/`.rom`/`.atx`/`.zip`/`.7z`. The in-app browser filters files by the requested action. Generic dump
and archive extensions do not identify a platform on their own; those files remain
**Unassigned**. ZIP/7z files are not extracted automatically. Use **Browse cores**
to choose a suitable core for a game when needed. Atari 2600, Atari 7800, and Atari
Lynx use Stella, ProSystem, and Beetle Lynx as their default mappings.

## Developer Architecture and Distribution Checks

See [ARCHITECTURE.md](../ARCHITECTURE.md) for the complete file and IPC inventory,
core-browser workflow, contribution guidance, and copyright boundaries.
`npm run check:distribution` checks the Git index for prohibited runtime files;
`git config core.hooksPath .githooks` enables the local pre-commit guard. Review
historical commits and asset licenses separately before publishing a release.

## RetroArch Developer Bootstrap and Production Packaging

```sh
npm ci
npm run setup:emulators
npm run dev
# Windows x64 setup wizard:
npm run build:win
# Linux host, with native Linux RetroArch prepared first:
npm run build:linux
```

- On Windows x64, the bootstrap script finds the newest stable version in the
  [official stable directory](https://buildbot.libretro.com/stable/), streams the
  `RetroArch.7z` archive, and extracts it into `emulators/retroarch/`. The 7-Zip
  development dependency is installed through npm. If `retroarch.exe` already
  exists, the installation is preserved without automatic updates or overwrites.
- On Linux, the script creates the directory skeleton and prints setup instructions;
  it does not download Linux binaries automatically. Place native x64 RetroArch and
  its dependencies in `emulators/retroarch/`, and ensure `retroarch` is executable.
  Do not use a Windows emulator binary when preparing a Linux package.
- Only the two empty `.gitkeep` files in the emulator skeleton are tracked by Git.
  `extraResources` packages the local RetroArch installation under
  `resources/emulators/retroarch/`, outside ASAR. BIOS/system, personal configuration,
  saves, ROMs, cache, and log directories are excluded. RetroArch runtime DLLs and
  assets are included, and license files are preserved. `cores/**` is excluded;
  cores are downloaded later with the user's approval.
- `beforePack` validates the executable for the target operating system and stops
  packaging when the emulator installation is missing or has the wrong format.
- On first launch, Windows and Linux packages prepare RetroArch in the background
  under `app.getPath('userData')/emulators/retroarch/`. Subsequent launches fill only
  missing or empty files and preserve existing settings. Locked autoconfig/CFG
  files are logged, skipped, and retried on the next launch. Cores and BIOS files
  are therefore written to the writable runtime rather than Program Files or a
  read-only AppImage. Existing user installations are preserved; application updates
  do not replace them automatically.
- `npm run build` compiles only Main, Preload, and Renderer; it does not produce an
  installer. `build:win`, `build:linux`, and `build:unpack` bundle the emulator.
- License and corresponding-source obligations for distributed RetroArch and any
  selected cores are part of release preparation. Git ignore rules and package
  exclusions are separate controls.

## Windows NSIS Setup Wizard

The default Windows target is NSIS, with `oneClick=false`, `perMachine=false`, and
`allowToChangeInstallationDirectory=true`. Desktop and Start Menu shortcuts and
launch-after-install are enabled; `differentialPackage=true`. The artifact is
`dist/zenith-<version>-setup.exe`, with the version read from `package.json`.

`npm run build:win` compiles the source and creates the NSIS package. To package an
existing build, use `npx electron-builder --win nsis --x64`. A portable executable
can be built separately with `npx electron-builder --win portable --x64`.
`forceCodeSigning=false` allows development
packaging without a certificate. `signAndEditExecutable=true` embeds `build/icon.ico` in the executable; the NSIS environment workaround remains enabled. These settings do not alter Windows security policy.

On Windows, `scripts/nsis-process.cjs` is activated by the existing `beforePack`
validation. For electron-builder 26.15.3, it normalizes only temporary EXE calls
through `WineVmManager.exec` that have no arguments and use the `RunAsInvoker`
environment. It supplies an absolute executable path, preserves the Windows
environment (`SystemRoot`, `PATH`, and `TEMP`), and hides the helper window.
`UNKNOWN`/`EBUSY`/`EPERM`/`EACCES` spawn errors receive bounded retries after
250/750/1500/3000 ms. Normal nonzero process exits are not retried, and persistent
errors propagate to the build. The adapter does not modify `node_modules`, NSIS
cache ACLs, or Windows protection settings. `USE_SYSTEM_MAKENSIS` is not forced;
electron-builder retains its own NSIS compiler and plugins.

The `WineVm` name does not mean that Wine is installed on Windows; this branch runs
Windows executables directly. Uninstaller generation also runs the temporary
installer after `makensis`. The adapter targets that specific step. When upgrading
electron-builder, run both `tests/nsis-process.test.mjs` and a real NSIS build. The
test covers environment preservation, bounded retries, and wizard configuration.
Persistent operating-system restrictions are not bypassed.

## Notifications and software updates

Open the header notification bell with the mouse, **D**, or controller **RT**.
The panel shows task progress and results for media, cores, RPCS3 and application
updates. Main persists bounded history in `userData/downloads.json`; live task
snapshots use `downloads:progress`. Unknown download sizes use an indeterminate
bar instead of a fabricated percentage. Completed cards fade out after four
seconds; active, queued and failed tasks remain. Update cards open Settings with
**Software Update** focused, without activating it. The notification panel has
no update controls.

Packaged releases check `aibrhmckr/zenith-os` on GitHub in the background using
`electron-updater`. Publish the versioned NSIS installer, its `.blockmap` and
`latest.yml` together and retain earlier artifacts for differential downloads.
A full download remains the fallback when delta data is unavailable. Installed
releases check automatically 20 seconds after startup and download available
updates in the background. **Settings → Software Update** shows the version and
live download percentage. Once staged, the card becomes **Update Ready**:
activate **Restart & install update** to install immediately when no game or
maintenance operation is running. Otherwise, the staged update installs on the
next normal application quit (`autoInstallOnAppQuit=true`). Download completion
alone never restarts the application. Development sessions do not contact the
release feed and show **Developer Build (Up to date)**.

OTA state is independent of notification history: clearing notifications or
reopening Settings cannot lose the staged installer status. Preload subscribes
to the six `app-update:*` lifecycle events and reads `app-update:status` for an
initial snapshot; `app-update:quit-and-install` is the explicit restart action.

To publish a release, increment the package version and run `npm run release`
from the intended build host with a GitHub release token supplied through the
environment (`GH_TOKEN`, never checked into source). The `prerelease` script
builds Main, Preload and Renderer first. Electron Builder then packages and
publishes to `aibrhmckr/zenith-os` as a non-draft release. On Windows this generates
the NSIS installer, `.blockmap` and `latest.yml`; upload/preserve all three assets.
Use `npm run build` followed by `npx electron-builder --win nsis --x64 --publish never`
to validate packaging without publishing. A real upgrade requires two installed
release versions; source/UI tests use a fake release provider and do not publish.

**Software Update** checks both the application and installed emulators in one
background operation (`software:update`). Repeated clicks reuse the running job.
The Settings card shows live component progress and checked/updated counts.
Development builds skip application installers and report **Developer Build (Up to date)**
while still checking installed emulators. Individual maintenance downloads feed this
tracker; Notifications receives one final success or failure summary.
Application installation/restart is a separate user action after maintenance;
any provider failure remains visible in Settings and Notifications. The operation refreshes
installed Libretro cores and Windows RPCS3 binaries
while preserving configuration, firmware, virtual disks and saves. It cannot run
alongside a game. Windows RPCS3 launch retains Zenith's loading mask until the
native PID watcher detects three consecutive positive-FPS render-window samples.
After 120 seconds without that signal, the session menu offers restart or exit.
Returning to a game still compiling keeps the loading mask. Linux uses the
fullscreen configuration without this Windows-specific readiness watcher.
