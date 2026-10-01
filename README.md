# Zenith OS

A console-style launcher and game library built with Electron and React. English is
the default language; select Turkish under **Settings → Language**.

## Local Game Library

On startup, Zenith creates the game directory if necessary and scans the ROM files
directly inside it. On Windows, development builds use the project's `games/`
directory, while packaged builds use `games/` beside the installed or portable
executable. Linux uses `userData/games/`, including during development, to avoid
writing to read-only AppImage mounts or `/opt`. Select **Scan library** to detect
new files.

Supported platforms include PS2, PS1, PSP, NDS, GBA, GBC, GameCube, Wii, N64, SNES,
NES, 3DS, Genesis, Dreamcast, Atari 2600, Atari 7800, and Atari Lynx. An `.iso` file
is identified as PSP when its filename or full path contains `PSP` (for example,
`(PSP)`) or `Vice City Stories`; other ISO files default to PS2. Platform hints and
file extensions are matched without regard to case. Subdirectories are not scanned.

For local artwork, use the same base name as the ROM: `games/Game.iso` with
`games/Game.jpg` or `games/Game.png`. JPG takes precedence when both exist. The
same image is also used as the backdrop; downloaded Libretro box art takes
precedence when available. If no image is available, the card displays the
platform name.

## Automatic Media Scraping and Previews

Games appear immediately on startup. Artwork is then downloaded in the background
from the [Libretro Thumbnail CDN](https://thumbnails.libretro.com/). No paid service,
account, or API key is required. The scraper matches `Named_Boxarts`, `Named_Snaps`,
and `Named_Titles` entries by platform, cleaned game title, and region. For example,
`New Super Mario Bros. (USA).nds` appears as `New Super Mario Bros.` in the library,
while the USA region is retained for matching.

Images are cached as `boxart.png`, `snap.png`, and `title.png` under
`app.getPath('userData')/media/{gameId}/`. The `userData/games.json` file stores game
identifiers, platform and region information, and local media paths. The thumbnail
CDN does not provide release year, developer, or genre metadata, so those fields
remain `null`. During Windows development, `userData` is typically `%APPDATA%/zenith`.

Artwork downloads use two concurrent workers, request timeouts, and size limits.
Local artwork and cached files remain available when the network is unavailable.
Unmatched entries are retried after 24 hours; **Scan library** requests an immediate
retry. Successfully downloaded images are not downloaded again.

Audio and video previews are discovered automatically through the
[Archive.org public JSON API](https://archive.org/developers/md-read.html). No account,
API key, or additional dependency is required. Music searches first use the cleaned
game title in the `vgm_ost` collection. If that collection returns no results, the
scraper searches public audio items with the same game title. From an item's
metadata file list, it prefers a title, theme, or menu track, followed by the first
suitable MP3. Tracks lasting 15–60 seconds are preferred; files are not trimmed.

For video, the scraper searches the platform's Video Snaps archives and matches an
MP4 by game title and region. If no match is found, it looks for a short preview,
snap, or gameplay item with the same title. Videos with a known duration exceeding
60 seconds and files larger than 5 MiB are excluded. If no archive or file matches,
the corresponding media field remains `null`.

MP3 and MP4 downloads use a queue independent of artwork scraping. Each request has
a **15-second** timeout, including redirects and body transfer, and a **5 MiB** size
limit. Audio and video do not wait for each other. Files are streamed directly to
the game's cache directory under `userData`; failed transfers remove incomplete
`.part` files. Each completed download updates `media.music` or `media.video` in
`games.json`. The `game-media-updated` IPC event refreshes the renderer's preview
without requiring another library scan.

The preferred paths, used for all automatic downloads, are:

    app.getPath('userData')/media/{gameId}/theme.mp3
    app.getPath('userData')/media/{gameId}/preview.mp4

On Windows, `userData` is typically `%APPDATA%/zenith` during development. Files in
these per-game directories always take precedence. Legacy files at
`userData/media/music/{gameId}.mp3` and `userData/media/videos/{gameId}.mp4` remain
readable as fallbacks. Project-root media directories are no longer used. To add
media manually, use the appropriate AppData paths and rescan the library; game IDs
are recorded in `games.json`.

Downloaded media is reused. Missing audio and video are retried independently after
24 hours or when **Scan library** is selected. Failed lookups from the previous
provider do not delay Archive.org requests. Network and access errors, malformed
responses, and missing files do not freeze the interface. Content availability for
every game and uninterrupted third-party service access are not guaranteed. Free
access does not mean that every item in an archive has an open license.

After a card remains hovered or focused by keyboard or gamepad for 800 ms, its
preview becomes active. Available video loops and audio previews begin playing;
audio fades in over 400 ms to a maximum volume of 30%. When an MP3 is available,
the video plays muted; otherwise, its own audio is used. Preview audio can be
muted in **Settings → Audio** or with the preview-audio shortcut. Dashboard shading
remains concentrated at the top and bottom so the central artwork stays visible.

Media stops and resets when the user leaves a card, selects another game, changes
window focus, opens the BIOS panel, or launches a game. Leaving a card fades its
music out over 150 ms; launching a game uses a 500 ms fade. Unsupported codecs or
blocked playback do not lock the interface.

Tests: `npm run test:scraper` covers offline CDN, cache, and media behavior;
`npm run test:media` checks preview delays, volume, and navigation in Electron.

Use the arrow keys, D-pad, or left stick to navigate the responsive library grid.
**LB/RB** on a gamepad, or **PageUp/PageDown** on a keyboard, changes the console
filter. **Y** opens Game Options, **H** opens the guide, and **B/Escape** leaves
search or closes the active console menu.

The header clock reads the system time in `HH:mm` format and updates every second.
The P1 badge represents the first connected gamepad. It displays a battery
percentage when the device supplies one, or a green connection indicator otherwise.
Battery percentage is not part of the standard Gamepad API; the computer's battery
is not used for this indicator.

The bottom bar, launch control, and drawer hints display keyboard keys or colored
gamepad badges according to the most recently used input device. Small analog-stick
movements are ignored.

**X** opens gamepad search and the on-screen keyboard (OSK). Moving up from the
first game row keeps focus at the grid boundary; it does not open search or the
keyboard. **A** can also open the OSK from the search input in gamepad mode. Merely
focusing or clicking the input does not open it.

On the OSK, **D-pad/left stick** moves between keys, **A** types, **X** deletes, and
**Menu/Start**, **B**, or **Escape** closes the keyboard. Space, Clear, and Done keys
are also available. On a physical keyboard, **/** focuses search and allows normal
text input. The badge beside the search field shows the active shortcut.

While the OSK is open, gamepad input is isolated from the library. Search text is
held as a draft and applied when the keyboard closes. After **B/Menu/Escape**,
focus returns to the previously selected game if it remains in the results, or to
the first result otherwise. If there are no results, the regular search input
receives focus; **X** can reopen editing. The left stick and D-pad share the same
navigation logic in all directions.

`npm run test:controller` verifies these transitions, the live clock, and battery
indicators with a simulated gamepad in the real Electron interface.

## Lore and Original Manual Drawer

For the selected game, press **H**, or choose **Y → Game Options → Guide & Lore**,
to open the frosted-glass drawer on the right. **Y/H**, **B**, or **Escape** closes
it. Typing H in the search input does not open the drawer. While the drawer is
open, background game selection, launching, and console filters do not receive
input, and media previews stop. Closing it restores focus to the previous control.

The **Lore & Tips** tab displays the English Wikipedia REST summary with a source
link. Release year and developer are populated only when they can be extracted
from the summary; missing values are not guessed. Spoiler-free introductory tips
are generic, static suggestions. No external AI service is used.

While the drawer is open, **LB/RB** are the only gamepad controls that change tabs.
The **right/left stick Y axis** or **D-pad up/down** scrolls the content smoothly.
In the **Original Manual** tab, **D-pad/left stick left/right** or the **left/right
arrow keys** turns pages. Directional input does not switch away from the Lore tab.
**PageUp/PageDown** scrolls by a larger amount, and **A** activates the focused
control. Page buttons use circular arrow icons. Tabs can also be selected with
the mouse or with **Tab/Shift+Tab** and **Enter**. Navigation stops at the first and
last pages. If no source is found, an **Original manual not found** card appears.
A failed page download does not prevent other pages from loading.

Manual searches first use Archive.org's `videogamemanuals` collection, then fall
back to `manuals` and `consolemanuals` using the same game title. Platform and
region matches take priority; walkthroughs, hint books, and strategy guides are
excluded. The first page is prefetched, and subsequent pages are cached as they
are viewed under `userData/media/{gameId}/manual/`. The manual's `index.json` stores
page order; the adjacent `lore.json` stores Wikipedia information. Cached
information and pages remain readable offline.

Each request has a **10-second** timeout. JSON/XML responses are limited to 2 MiB,
page images to 8 MiB, and a manual to 512 listed pages. Late responses do not
reopen a closed drawer or replace a newly selected page.

The `features: { manualsEnabled: true, loreEnabled: true }` configuration and
`setFeatures()` method in `createGuideService` provide an extension point for a
future Settings page. A disabled feature makes no network requests and does not
display cached content. These feature flags do not yet have a dedicated Settings UI.

Tests: `npm run test:guide` covers mocked APIs, caching, feature flags, and timeouts;
`npm run test:guide-ui` covers Electron IPC, Y/H/B/Escape, pagination, focus, and
offline states.

## Media Storage Policy

New media downloaders must be configured in the main process with
`app.getPath('userData')` and use `gameMediaDirectory(userData, gameId)` from
`src/main/services/mediaPaths.js`. Downloaded covers, videos, music, and manuals
belong only under `userData/media/{gameId}/`; manual pages belong in `manual/`.
Do not use the project root, working directory, or a game object's `mediaDirectory`
field as a download destination. The shared helper requires an absolute `userData`
path and rejects game IDs that could escape the cache directory. If the cache is
not writable, optional media is skipped without falling back to the project directory.

`.gitignore` excludes local ROM, media, save, and log directories and media
extensions at every depth, regardless of case. The `.md` extension remains
available for source documentation; Genesis `.md` ROMs must be stored in `games/`
or `roms/`. Ignore rules do not remove already tracked files or Git history.
`npm run test:media-paths` verifies destination restrictions and ignore rules
using real Git operations.

Integration test: `npm run test:local-games` uses a temporary directory and a hidden
Electron window to verify scanning, artwork, filtering, keyboard input, and
simulated gamepad input.

## Launching Games with RetroArch

During Windows development, place RetroArch at
`emulators/retroarch/retroarch.exe` in the project root and libretro DLLs under
`emulators/retroarch/cores/`. Linux development uses the native `retroarch`
executable and `.so` cores. Packaged Windows and Linux applications prepare a
writable runtime under `app.getPath('userData')/emulators/retroarch/` from the
bundled resources.

Default launch mappings cover the supported platforms, including GBC, GameCube,
Wii, 3DS, Dreamcast, and the Atari systems. PSP uses `cores/ppsspp_libretro.dll`.
PS2 prefers `cores/pcsx2_libretro.dll`, falling back to `cores/lrps2_libretro.dll`.
PS1 prefers `duckstation_libretro.dll`, then `mednafen_psx_hw_libretro.dll`, then
`swanstation_libretro.dll`. Linux uses the corresponding `.so` filenames. Games
without an automatic mapping can use **Browse cores** to select a core manually.

Launch the selected game with **Enter**, gamepad **A**, or **Select / Launch**.
Enter does not launch a game while the search input is active. The ROM path is
passed as a separate process argument, so filenames containing spaces and special
characters are supported. RetroArch runs with its own directory as `cwd`, using
`-L <absolute_core_path> <game_path> -f --appendconfig <absolute_session_config>`.
Its stdout and stderr are forwarded to the application's main terminal.

A launch animation is displayed while the process starts. Zenith hides once the
emulator starts and returns to the foreground when it exits. Only one game session
can run at a time. Missing RetroArch, core, or ROM files and process errors are
reported to the user. Launching and playing indicators reset when an error dialog
opens or the process ends, allowing another attempt after the dialog is dismissed.

Install RetroArch in the appropriate runtime directory. Missing cores are offered
through Zenith's confirmation panel and downloaded from Libretro Buildbot for
Windows/Linux x64. The physical core file is checked before RetroArch is spawned.
The prompt offers **Download** and **Cancel**, with **Browse cores** available for
manual selection. Download progress and errors are shown in the panel; a verified
installation automatically retries the launch. BIOS files are never downloaded;
users select their own dumps.

## Controller Bindings and Settings

| Action                             | Gamepad            | Keyboard                            |
| ---------------------------------- | ------------------ | ----------------------------------- |
| Launch game                        | A                  | Enter                               |
| Game Options / Guide               | Y → Guide & Lore   | O / H                               |
| Search                             | X                  | /                                   |
| Filter panel                       | View               | F                                   |
| Change console                     | LB / RB            | PageUp / PageDown                   |
| Settings                           | Menu               | Context Menu key or Settings button |
| Add game                           | R3                 | + / Insert                          |
| Delete game                        | L3                 | Delete                              |
| Back / close                       | B                  | Escape                              |
| Zenith menu (dashboard or in-game) | View + Menu / Home | Escape / F10                        |

Toggle preview audio with **RT / M**; rescan the library with **LT / R**.

Search opens only through an explicit command; moving up from the first row keeps
focus on that row. Physical keyboard and mouse searches do not open the OSK. On
the OSK, A types, X deletes, and B/Menu closes it and restores focus to the game
card. In the guide, LB/RB tab navigation stops at the ends; the right stick or
D-pad scrolls content, and left/right turns manual pages.

### Dashboard, Audio, and On-Screen Keyboard

Poster cards measure 144×216 px, with a 48 px safe zone on each side. The grid uses
as many columns as fit, a fixed 16 px gap, and left alignment. Only one row is
visible while the first row has focus. Moving down expands the viewport to two
rows over 300 ms; returning to the first row collapses it. Columns are not capped
at eight: a 1920 px window fits 11 cards, while a 1280 px window fits seven.
Narrower windows retain the card dimensions and reduce the column count.
D-pad and left-stick navigation follows the current column count, and lower rows
scroll vertically and smoothly. The hero area shows only the game title and
platform. The center of the background is neither darkened nor blurred; shading
is confined to the top and bottom.

In **Settings → Language**, A opens the dropdown, up/down selects an option, A
applies it, and B closes the dropdown first. Use the D-pad or left stick throughout
Settings, and B to leave. **Settings → Audio** provides two persistent switches:
**Menu sound effects** and **Video & background preview audio**.

Menu effects use the supplied `navigate.wav`, `toggle.wav`, and `launch.wav` files
under `src/renderer/src/assets/sounds/`, bundled through Vite. There are no synthetic
tones or WAV upload controls. Disabling menu sounds silences navigation and toggle
effects; the launch sound plays independently while preview audio fades out over
500 ms. Navigation effects use a pool of four Audio instances so rapid movements
can overlap naturally. Previews wait 800 ms, fade in to 30% over 400 ms, and fade
out over 150 ms when a card is left. Menu sounds are enabled by default; video/BGM
audio is disabled. Preferences are stored under the `zenith-preferences` local
storage key and survive application restarts.

The OSK opens only for gamepad search. It uses an iOS-style three-row letter layout
with Backspace at the end of the final letter row. The globe key switches between
TR and EN layouts, and the layout preference is saved. The bottom row contains
?123, the globe, cursor arrows, a wide Space key, Clear, and Search/Done.
?123 / ABC toggles letters and symbols; ← / → moves the text cursor. Insertion and
deletion respect the selection or cursor position. B/Menu closes the OSK and
restores focus to the selected game card. Physical keyboard search does not open it.

### Menu and Exit Combination

Settings initially focuses the Language dropdown. The filter panel starts on
**All consoles**; gamepad input stays within the open panel, and B returns to the
card without changing the filter. **Menu & Exit Combination** shows badges for the
active input device. Press A or Enter to edit it; two pulsing boxes capture two
different keys or buttons in sequence. B or Escape cancels and preserves the
previous combination. Gamepad and keyboard mappings are stored separately in
`userData/zenith-preferences.json`, persist across restarts, and are shared with
the in-game input bridge.

With the default mapping, releasing View or Menu individually opens filters or
Settings. Pressing them together opens the Zenith menu without triggering those
individual actions. Individual Zenith actions assigned to combination buttons are
deferred until release to prevent conflicts.

### Cores and BIOS Files

The missing-core panel downloads only an allowed core file from the official
Libretro Windows/Linux x64 archive. ZIP CRC, size, PE/ELF64 headers, and the target
filename are validated. Valid installed cores are reused; empty or invalid files
can be replaced through a verified, atomic installation. Missing server files and
connection errors appear in the panel rather than opening RetroArch's menu.
PS2 tries PCSX2 followed by LRPS2; PS1 tries DuckStation, Beetle PSX HW, and SwanStation.

**Settings → System & Console Status** lists only platforms represented in the
library. Before launch, BIOS checks apply only to PS2, PS1, and Dreamcast. NDS,
PSP, GBA, N64, and SNES do not have a BIOS gate. **Select / upload BIOS** copies the
selected file to the appropriate RetroArch system directory:

- PS2: `system/pcsx2/bios/` — a 4 or 8 MiB `.bin` dump.
- PS1: `system/` — `scph5500.bin`, `scph5501.bin`, or `scph5502.bin`, depending on region.
- Dreamcast: `system/dc/` — `dc_boot.bin`.

These checks validate filenames and sizes; they do not guarantee that a BIOS dump
is correct. Existing files with the same name are not overwritten. PS2 `.rom`
files receive a `.bin` extension without changing their contents. After upload,
a **Ready** state exposes the **Launch game** option. Confirming **Delete BIOS**
removes only the selected platform's BIOS files and preserves the shared system
directory. **Open folder** opens the destination in Windows Explorer. Zenith does
not distribute or download BIOS files or ROMs.

### Sessions and Game Management

Each game runs in a detached child process. Zenith hides and returns when the
process emits `exit`. Per-session save and state directories live under
`userData/media/{gameId}/`. On Windows, the XInput bridge monitors the configured
gamepad combination, Home, and keyboard shortcuts while the emulator has focus.
The default combination is View + Menu, with Escape / F10 as keyboard fallbacks.
Windows or the controller driver may not expose Home, and Xbox Game Bar may
intercept it. The Zenith menu offers **Return to game**, **Stop game & return to
Zenith**, and **Quit to desktop**. The dashboard menu also allows the application
to exit.

RetroArch session configuration sets `input_menu_toggle_gamepad_combo=0`,
`input_menu_toggle_btn=nul`, and `input_menu_toggle=nul`. RetroArch's exit bindings
are also disabled for the session so Escape does not directly terminate the
emulator. `pause_nonactive=true` pauses the game while the Zenith menu has focus.
The application does not change other applications' settings or global Game Bar
shortcuts.

**Add game** asynchronously copies the selected ROM/ISO into the central `games/`
directory, or `userData/games/` on Linux, including development builds. The source
file is unchanged. Existing games with the same name are not overwritten; the new
copy receives a numbered filename. The library references this central copy, so
removing the original desktop file does not remove the game from Zenith.

Confirming **Delete** permanently removes the central ROM file, library entry,
and all media, manual, and save data under `userData/media/{gameId}/`. For legacy
external references, the original source file is preserved and only Zenith's
entry and cache are removed. The confirmation explicitly identifies source-ROM
deletion; no files are changed before confirmation. Deletion waits for active
scraper writes before removing the cache.

Dynamic media is stored only under `app.getPath('userData')/media/`. DLL, EXE, BIOS,
ROM, and media patterns are protected by `.gitignore` and distribution exclusions.
A narrow Git exception permits the three supplied application WAV files; downloaded
game media is not covered by that exception. Previously tracked RetroArch DLL/EXE
files were removed from the Git index while preserving local copies. Historical
commits were not rewritten.

Tests: `npm run test:console-services`, `npm run test:console`, `npm run test:bios`,
`npm run test:launcher`, `npm run test:controller`, `npm run test:guide-ui`, and
`npm run test:media`. Network, ROM, DLL, and gamepad data are synthetic; physical
controller and RetroArch compatibility require separate hardware testing.

## Legal Notice

Zenith OS is a frontend and library-management tool. It does not include or
distribute copyrighted game ROMs, ISO files, or BIOS data. Users are responsible
for using legally obtained backups of the physical games and console hardware
they own.

Launcher test: `npm run test:launcher` exercises the real Electron IPC and interface
with a mocked emulator process and dialogs; it does not run actual ROMs.

## Recommended IDE Setup

- [VSCode](https://code.visualstudio.com/) + [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) + [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)

## Project Setup

### Install

```bash
$ npm install
```

### Development

```bash
$ npm run dev
```

### Build

```bash
# For Windows
$ npm run build:win

# For macOS
$ npm run build:mac

# For Linux
$ npm run build:linux
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

Game Options contains only **Guide & Lore** and **Delete game**, with initial focus
on the guide. Its selected index is maintained separately from DOM focus, resets
when reopened, and is restored when window focus returns. B closes the panel and
returns focus to the associated card. The console filter lists only platforms
present in the library plus **All consoles**, with four-direction grid navigation.

`npm run test:import-hotkeys` verifies central imports and combination handling.
`npm run test:hotkeys` covers two-step assignment and cancellation, persistence,
dashboard and in-game menus, native bridge messages, and RetroArch session settings
using synthetic data.

The Add game filter includes Atari `.a26`/`.a78`/`.lnx`, `.smd`/`.v64`, and
`.bin`/`.rom`/`.atx`/`.zip`/`.7z`. **All Files** is the second filter. Generic dump
and archive extensions do not identify a platform on their own; those files remain
**Unassigned**. ZIP/7z files are not extracted automatically. Use **Browse cores**
to choose a suitable core for a game when needed. Atari 2600, Atari 7800, and Atari
Lynx use Stella, ProSystem, and Beetle Lynx as their default mappings.

## Developer Architecture and Distribution Checks

See [ARCHITECTURE.md](ARCHITECTURE.md) for the complete file and IPC inventory,
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
launch-after-install are enabled; `differentialPackage=false`. The artifact is
`dist/zenith-1.0.0-setup.exe`, with the version read from `package.json`.

`npm run build:win` compiles the source and creates the NSIS package. To package an
existing build, use `npx electron-builder --win nsis --x64`. A portable executable
can be built separately with `npx electron-builder --win portable --x64`.
`forceCodeSigning=false` and `signAndEditExecutable=false` allow development
packaging without a certificate; they do not alter Windows security policy.

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

## RetroArch Synchronization and Downloaded Core Files

Every launch supplies a per-game `userData/media/{gameId}/session.cfg` through
`--appendconfig` using an absolute path. It sets `video_vsync = "true"`,
`video_refresh_rate = "60.0"`, `audio_sync = "true"`, `audio_rate_control = "true"`,
`fastforward_ratio = "1.0"`, `video_max_swapchain_images = "3"`, and
`vrr_runloop_enable = "true"`. These session settings also apply to existing
installations. The configured refresh-rate value is 60.0 Hz; actual game timing
still requires validation with the core, audio driver, and display in use. See the
[upstream configuration](https://github.com/libretro/RetroArch/blob/master/retroarch.cfg).

Session configuration also disables `notification_show_osd`,
`notification_show_autoconfig`, `video_osd_widgets`, `notification_show_core_load`,
and the classic text OSD through `video_font_enable`. On Windows, it selects
`audio_driver = "xaudio"`; Linux and Steam Deck retain their native audio driver.
Audio is enabled with `audio_enable = "true"`, unmuted with
`audio_mute_enable = "false"`, and set to `audio_volume = "0.0"` (0 dB). These
settings do not change the operating system's mixer or output device.

Core downloads are extracted into native Node.js Buffers and written to new
temporary files before atomic installation. On Windows, only the newly downloaded
and validated core's `Zone.Identifier` stream is removed before publication.
Missing streams are normal; other cleanup failures appear in the download error
UI. Existing manually installed cores are not unblocked. This follows the
named-stream operation described in
[Microsoft's Unblock-File documentation](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.utility/unblock-file).
No PowerShell process or system security-policy change is required. Cores remain
excluded from electron-builder packages; this process runs when the installed
application downloads a core.

## Legal Disclaimer

Zenith OS is an open-source launcher and frontend interface designed for library management and emulator automation. Zenith OS does not contain, distribute, or promote any copyrighted ROMs, ISOs, game assets, or proprietary console BIOS dumps. Users are solely responsible for providing their own legally dumped games and BIOS files.

## Third-Party Licenses & Attribution

- **RetroArch & libretro:** This project utilizes the open-source RetroArch frontend under the GNU General Public License v3.0 (GPL-3.0). RetroArch and the libretro ecosystem are developed and maintained by the Libretro team and contributors; individual emulation cores also have their own upstream developers and licenses. Visit [RetroArch](https://www.retroarch.com) and [Libretro on GitHub](https://github.com/libretro) for source code and documentation.
- Core binaries are not bundled with releases and are downloaded on-demand directly by the user.
- See the [RetroArch GPL v3 license](https://github.com/libretro/RetroArch/blob/master/COPYING) and [Libretro license inventory](https://docs.libretro.com/development/licenses/) for upstream terms. Releases that include RetroArch must preserve its license notices and provide access to the corresponding source for the distributed version in accordance with GPL v3; these attribution links alone do not replace those obligations.
