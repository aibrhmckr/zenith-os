# Using Zenith OS

Library management, controller navigation, media previews, and personalization.

[Project overview](../README.md) · [User guide](USER_GUIDE.md) · [Runtime reference](RUNTIME.md) · [Build and release guide](BUILDING.md)

## Contents

- [Local Game Library](#local-game-library)
- [Automatic Media Scraping and Previews](#automatic-media-scraping-and-previews)
- [Lore and Original Manual Drawer](#lore-and-original-manual-drawer)
- [Controller Bindings and Settings](#controller-bindings-and-settings)
- [Wallpapers and library cache](#wallpapers-and-library-cache)
- [In-app file browser and session isolation](#in-app-file-browser-and-session-isolation)

## Local Game Library

On startup, Zenith creates the game directory if necessary and scans the ROM files
directly inside it. On Windows, development builds use the project's `games/`
directory, while packaged builds use `games/` beside the installed or portable
executable. Linux uses `userData/games/`, including during development, to avoid
writing to read-only AppImage mounts or `/opt`. Select **Scan library** to detect
new files.

Supported platforms include PS3, PS2, PS1, PSP, NDS, GBA, GBC, GameCube, Wii, N64, SNES,
NES, 3DS, Genesis, Dreamcast, Atari 2600, Atari 7800, and Atari Lynx. ISO classification inspects bounded disc metadata for PS3_GAME/PSP_GAME,
PS3 system headers, and PS2/PS1 SYSTEM.CNF boot entries. Explicit PS3 filename/path
hints take precedence over automatic inspection; PSP and PS2 hints remain fallbacks.
Unrecognized ISO files default to PS3. **Game Options (Q) → Change Platform**
saves a per-game override; **Auto Detect** removes it. Manual choices survive rescans
and restarts. Launch routing uses the current library platform rather than a stale
renderer label. Generic ROM subdirectories are not scanned.

For local artwork, use the same base name as the ROM: `games/Game.iso` with
`games/Game.jpg` or `games/Game.png`. JPG takes precedence when both exist. The
same image is also used as the backdrop; downloaded Libretro box art takes
precedence when available. If no image is available, the card displays a
platform icon and the game title.

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
filter. **Y** opens search; **X** clears an active search or opens Game Options when
search is empty. **H** opens the guide, and **B/Escape** leaves
search or closes the active console menu.

The header clock reads the system time in `HH:mm` format and updates every second.
The P1 badge represents the first connected gamepad. It displays a battery
percentage when the device supplies one, or a green connection indicator otherwise.
Battery percentage is not part of the standard Gamepad API; the computer's battery
is not used for this indicator.

The bottom bar, launch control, and drawer hints display keyboard keys or colored
gamepad badges according to the most recently used input device. Small analog-stick
movements are ignored.

**Y** opens gamepad search and the on-screen keyboard (OSK). Moving up from the
first game row focuses the action dock; it does not open search or the keyboard. **A** can also open the OSK from the search input in gamepad mode. Merely
focusing or clicking the input does not open it.

On the OSK, **D-pad/left stick** moves between keys, **A** types, **X** deletes, and
**Menu/Start**, **B**, or **Escape** closes the keyboard. Space, Clear, and Done keys
are also available. On a physical keyboard, **/** focuses search and allows normal
text input. The badge beside the search field shows the active shortcut.

While the OSK is open, gamepad input is isolated from the library. Search text is
held as a draft and applied when the keyboard closes. After **B/Menu/Escape**,
focus returns to the previously selected game if it remains in the results, or to
the first result otherwise. If there are no results, the regular search input
receives focus; **Y** can reopen editing. The left stick and D-pad share the same
navigation logic in all directions.

`npm run test:controller` verifies these transitions, the live clock, and battery
indicators with a simulated gamepad in the real Electron interface.

## Lore and Original Manual Drawer

For the selected game, press **H**, or choose **X → Game Options → Guide & Lore** (with no active search),
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

## Controller Bindings and Settings

| Action                             | Gamepad            | Keyboard                            |
| ---------------------------------- | ------------------ | ----------------------------------- |
| Launch game                        | A                  | Enter                               |
| Game Options / Guide (no search)   | X → Guide & Lore   | Q or O / H                          |
| Search                             | Y                  | /                                   |
| Clear active search                | X                  | X / Backspace (outside text input)  |
| Filter panel                       | View               | F                                   |
| Change console                     | LB / RB            | PageUp / PageDown                   |
| Settings                           | Menu               | Context Menu key or Settings button |
| Add game                           | R3                 | + / Insert                          |
| Delete game                        | L3                 | Delete                              |
| Back / close                       | B                  | Escape                              |
| Zenith menu (dashboard or in-game) | View + Menu / Home | Escape / F10                        |

Toggle preview audio with **M**; rescan the library with **LT / R**. **RT** opens notifications.
From the first game row, **Up** focuses the action dock without opening search. Use
**Left/Right** to choose Filter, Search, Add Game or Scan, **A** to activate, and
**Down/B** to return to the selected game. Inside the on-screen keyboard, X deletes,
Y inserts a space, and R2/Start completes the search.

Search opens only through an explicit command; moving up from the first row
focuses the action dock without opening search. Physical keyboard and mouse searches do not open the OSK. On
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
scroll vertically and smoothly. The spotlight shows a game logo or title, platform, available metadata, and a
short synopsis. A soft gradient behind the spotlight improves text contrast;
top and bottom shading keeps navigation readable over artwork.

In **Settings → Language**, A opens the dropdown, up/down selects an option, A
applies it, and B closes the dropdown first. Use the D-pad or left stick throughout
Settings, and B to leave. **Settings → Audio** provides two persistent switches:
**Menu sound effects** and **Video & background preview audio**.

Menu effects use original `navigate.wav`, `toggle.wav`, `back.wav`, and `launch.wav`
assets under `src/renderer/src/assets/sounds/`, bundled through Vite. Regenerate
the deterministic 44.1 kHz / 16-bit PCM voices with `node scripts/generate-sounds.js`.
Synthesis happens at build preparation, not through live browser oscillators.
Disabling menu sounds silences navigation, confirmation and back effects; the launch sound plays independently while preview audio fades out over
500 ms. Navigation effects use six preloaded Audio instances with no input throttle;
when all channels are busy, the oldest is restarted so new focus feedback is never
discarded. Up to six navigation sounds can overlap naturally. Previews wait
800 ms, fade in to 30% over 400 ms, and fade
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
A narrow Git exception permits the four generated application WAV files; downloaded
game media is not covered by that exception. Previously tracked RetroArch DLL/EXE
files were removed from the Git index while preserving local copies. Historical
commits were not rewritten.

Tests: `npm run test:console-services`, `npm run test:console`, `npm run test:bios`,
`npm run test:launcher`, `npm run test:controller`, `npm run test:guide-ui`, and
`npm run test:media`. Network, ROM, DLL, and gamepad data are synthetic; physical
controller and RetroArch compatibility require separate hardware testing.

## Wallpapers and library cache

Open **Settings → Wallpaper** to choose from five original animated themes,
including **Luminescent Glade**, or import an image or muted looping video.
Imported copies are stored in `userData/wallpapers/`. Game artwork remains the default
priority unless **Show only the selected wallpaper** is enabled. This mode also
stops all game preview video/audio and theme music, including audio fade tails.
The preview-audio switch in Settings is disabled with an explanation while the
mode is active; the saved audio preference is retained.

Delete an imported wallpaper using its trash button or controller **X**, then confirm.
For multiple items, enter **Select** mode with **Y** (keyboard **S**). Toggle imported
cards with **A**, **Enter**, or a click, then choose **Delete selected / X** (keyboard
**Delete**) and confirm. **B / Escape** cancels the confirmation first, then selection
mode; marking a card never changes the active wallpaper. Entering selection mode
keeps focus on the current card and immediately selects it (one selected). Moving
to another card and pressing A toggles its checkbox without leaving selection mode.
Unmarked files are kept. **Delete all wallpapers** also requires confirmation. Removing the active
wallpaper restores **Zenith Minimal Dark**; original import files and built-in
themes are preserved.

**Scan library / R** reuses existing nonempty media files and only searches for
missing media. **Game Options → Search media again** explicitly requests a refresh.
The mouse cursor hides on gamepad input or after two seconds of inactivity and
reappears when the mouse moves.

## In-app file browser and session isolation

**Add Game**, wallpaper import and the RPCS3 **Install Firmware / Install PKG** actions use the fullscreen
in-app browser. Choose an approved location, navigate with the D-pad/left stick
or arrow keys, press **A / Enter** to enter a folder or import a file, and **X** to confirm the
focused file. **B / Backspace** moves to the parent directory (closing at the root
list); **Escape / Close** dismisses immediately. **LB/RB**, left/right arrows or
**Page Up/Page Down** move between the quick-access, file-list and preview panels.
Each panel remembers its focused row. Quick-access locations appear in the sidebar. Access is restricted to the managed
games directory, RetroArch runtime, userData, Desktop, and Downloads; arbitrary
drive roots and the entire home directory are not exposed. Files are filtered
for the requested action and show their physical size and modification date.
Focused folders have an asynchronous content summary, including nested files of all
types. Scans stop after 10,000 entries or a two-second work budget and do not follow
links. Partial results are explicitly labeled; changing focus cancels the old scan.
Selected files are copied through Main-owned, single-use tokens rather than arbitrary
renderer paths. Original source files remain untouched. PUP and PKG actions have separate
extension filters and purpose-bound tokens. Other consoles' BIOS uploads still use
the operating system picker.

System & Console Status presents consistent console cards with vector icons, friendly
emulator names and physical Ready/Missing checks. RPCS3 shows its recorded release
version only when the record matches the installed executable. Manual installations
without a matching record show the emulator name without an inferred version.
**Show details** reveals runtime paths and firmware diagnostics. RPCS3's four primary
actions use a 2×2 grid with directional keyboard/controller navigation; download consent
and operation cancellation remain separate actions.

RPCS3 game-window keyboard shortcuts and controller PS/Home bindings are disabled
in its managed portable profile, with original files backed up on first change.
Other controller mappings and in-game system dialogs remain available. Use Zenith's
session menu to return, stop, or **Restart game**. Restart terminates the owned child,
waits for process close and cleanup, then runs the normal verified launch pipeline.
If the process cannot stop within ten seconds, restart fails visibly instead of
starting a second emulator. These controls do not guarantee prevention of unrelated
RPCS3 crashes or override independent Steam desktop shortcuts.
