# Emulator and Media Runtime

Runtime locations, launch arguments, session settings, and media storage rules.

[Project overview](../README.md) · [User guide](USER_GUIDE.md) · [Runtime reference](RUNTIME.md) · [Build and release guide](BUILDING.md)

## Contents

- [Media Storage Policy](#media-storage-policy)
- [Launching Games with RetroArch](#launching-games-with-retroarch)
- [RetroArch Synchronization and Downloaded Core Files](#retroarch-synchronization-and-downloaded-core-files)
- [PlayStation 3 / RPCS3 Setup](#playstation-3--rpcs3-setup)

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

## PlayStation 3 / RPCS3 Setup

RPCS3 is a standalone runtime under `userData/emulators/rpcs3/`.
From the RPCS3 status panel, Windows x64 users can confirm an on-demand download
from the official RPCS3 GitHub releases. Archives are SHA-256 checked and tested
before publication. Linux currently requires manual runtime installation.
Use **Install PS3 Firmware** to select your legally obtained Sony PS3UPDAT.PUP,
or **Install PS3 Package** for a local PKG. Installation uses the official headless
--installfw / --installpkg commands. Firmware success follows physical dev_flash
validation even if RPCS3 crashes during teardown; PKG also requires fresh success logs.
Neither firmware nor RPCS3 is bundled. PKG installation automatically discovers
bootable titles in the managed dev_hdd0/game directory. Add Game also accepts PKG
installation inputs; Rescan discovers games installed directly through RPCS3.
Installed titles display their PARAM.SFO name and launch their original EBOOT.BIN. See [RPCS3 integration](../RPCS3_INTEGRATION.md)
for paths, limits, IPC contracts and supported launch targets.
