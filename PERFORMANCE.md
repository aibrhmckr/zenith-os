# Performance work and verification

Measured on 22 October 2026. This change covers main-process responsiveness, navigation,
optional background jobs and local Electron verification. It does not claim a particular
game FPS or a guaranteed refresh rate on every GPU.

## Main process and disk

- `src/main/services/workScheduling.js` provides shared library snapshots, cooperative
  metadata batches, serialized/coalesced persistence, progress batching and a bounded queue.
- `src/main/index.js` uses asynchronous directory reads and yields between groups of eight
  games. A launch uses one fresh library snapshot instead of scanning repeatedly. Import,
  deletion, platform correction and PKG installation invalidate the snapshot. Standalone
  scan IPC still refreshes disk; the renderer's immediately preceding local scan can be reused.
- General Settings no longer polls the whole library. The System Status subpage retains
  physical core/BIOS checks every two seconds, only while open, without rescanning the library.
  Removing a DLL outside Zenith still changes Ready to Missing; launch also rechecks disk.
- Core ZIPs stream to exclusive temporary files. Inflation, CRC and binary validation run
  in a worker thread, using native zlib CRC. Published DLL verification reads bounded chunks
  and closes the file handle before replacement/cleanup. Existing validation and rollback remain.
- `games.json` changes coalesce over 25 ms; download history writes coalesce over one second.
  IPC progress coalesces over 100 ms without dropping changed games. Shutdown waits for
  installer completion/rollback and then flushes the queued writes.
- Runtime seeding records bundle identity and critical binaries. Subsequent starts verify
  these files without traversing unchanged autoconfig directories. Missing dependencies
  still trigger repair; an unwritable optional receipt does not prevent launch.
- File-browser later pages reuse a sorted listing for up to 30 seconds while checking
  directory modification time. Returned files and import tickets are still revalidated.
  Folder summaries have a bounded ten-second cache. The first page always refreshes.

## Navigation

- Above 96 games, `libraryWindow.js` mounts nearby rows and the selected row's neighbours,
  rather than the whole collection. Logical indices remain global; mouse scroll, filtering,
  resize and two-row expansion retain their existing meaning. Small libraries are unchanged.
- Search results are memoized. Renderer media patches merge in 100 ms batches, flushed before
  final scan results so delayed patches cannot overwrite the completed snapshot.
- Grid measurements skip unchanged widths during height animations.
- File-browser preview authorization waits 160 ms before loading a newly focused preview;
  date and size formatters are reused instead of constructed per row.
- Wallpaper gallery previews mount only near the viewport, unloading offscreen video and
  animated themes. This is visibility-based loading, not an image-resizing thumbnail pipeline.
- Idle connected gamepads still poll each animation frame, but do not dispatch DOM/modal
  routing when there is no input. Presses, held controls, release edges and right-stick motion
  remain delivered. Full Spotlight records log only in development with
  `localStorage.setItem('zenith-debug', 'true')`.

## Background work

- Optional media jobs run with two game-level slots; explicit retries can enter ahead of
  pending automatic jobs. Each job may request several media types concurrently.
- Emulator sessions pause new optional work. Existing network requests may finish; subsequent
  requests wait until the session ends. This is cooperative pausing, not termination of an
  in-progress network transfer or an emulator update.
- Archive discovery has a 45-second per-kind overall budget in addition to request timeouts.
  Catalogs are bounded/cached, title matching is indexed and explicit retry clears lookups.
- Successfully extracted partial PS3 ISO media is remembered. Unchanged failures wait one
  hour before another automatic extraction; explicit retry bypasses this cooldown.
- Empty manual searches are remembered for 24 hours across launches; network errors are not
  persisted as successful misses.
- Core updates retain the 24-hour verification window, then use ETag/Last-Modified conditional
  requests where supplied. A 304 response verifies the local file and creates no download job.
- GPU queries cache successful results for 60 seconds and refresh on GPU information/crash
  events. Cache-only or disabled-media scans do not log every game individually.

## Reproducible local measurements

Run `node scripts/benchmark-performance.mjs`. Fixtures contain synthetic data only; no ROM,
BIOS, user profile or internet access is required. Fixture construction/cleanup is outside
the timed scan. Logging is disabled for the benchmark. Results vary with storage and system load.

Host: Windows, AMD Ryzen 7 7800X3D, 31.2 GiB RAM, Node 24.21.0.
One local run produced:

| Games | Media state                 | Scan + persistence | First event-loop yield | Maximum sampled loop delay | Sync stat calls | Progress messages | Network requests |
| ----: | --------------------------- | -----------------: | ---------------------: | -------------------------: | --------------: | ----------------: | ---------------: |
|   100 | Missing, downloads disabled |             127 ms |                1.26 ms |                   19.61 ms |           2,200 |                 1 |                0 |
|   100 | Complete local cache        |             221 ms |                0.32 ms |                   16.11 ms |           2,700 |                 1 |                0 |
| 1,000 | Missing, downloads disabled |             851 ms |                1.96 ms |                   17.78 ms |          22,000 |                 1 |                0 |
| 1,000 | Complete local cache        |           1,956 ms |                1.83 ms |                   16.61 ms |          27,000 |                 7 |                0 |
| 5,000 | Missing, downloads disabled |           4,317 ms |               10.47 ms |                   16.81 ms |         110,000 |                 1 |                0 |
| 5,000 | Complete local cache        |           9,656 ms |                8.22 ms |                   24.54 ms |         135,000 |                31 |                0 |

The 50 MiB synthetic core worker completed in 116 ms; the caller yielded after 2.18 ms.
The earlier audit observed 2,180–3,823 ms initial blocking and 63,000–77,000 stat calls
for 1,000 games. Those earlier measurements are historical context, not a controlled
same-run A/B benchmark. The current harness measures the scraper and progress publisher;
it is not total application boot time, network throughput or GPU frame time.

## Verification

- 205 Node unit tests passed in the final full run. New tests cover invalidation during
  scanning, concurrent failed writes, queue pause/concurrency, progress retention, virtual
  indices, worker extraction, conditional updates, missing-manual caching, provider deadlines,
  paginated file security and runtime receipts.
- 24 Electron scenarios passed: the 20 existing screen/launcher suites, a new large-library
  scenario, PSP-path and critical-runtime variants, and Vite development-renderer startup.
- The 1,000-game Electron test initially mounted 75 cards, navigated across virtual rows
  with a simulated controller, scrolled to distant rows and filtered to ten games. It also
  verifies that normal `app.quit()` waits for library/history persistence.
- Production build passed. ESLint passed for changed/new JavaScript files. A broader source
  lint run reported existing line-ending warnings but no errors.
- Windows transient cleanup locks occurred during intermediate runs. Test fixture cleanup
  now retries briefly where introduced/exercised by this change; final tests passed without
  relaxing application assertions. An intermediate serial dependency-cache test stalled;
  the final normal-parallel full suite passed, including that unchanged test.

Suggested verification commands (PowerShell):

```powershell
New-Item -ItemType Directory -Force .test-tmp | Out-Null
$env:TEMP = Join-Path $PWD '.test-tmp'
$env:TMP = $env:TEMP
node --test tests/*.test.mjs
npm run build
npx electron tests/performance.cjs
node scripts/benchmark-performance.mjs
npm run test:dev-renderer
```

## Device validation limits

Electron 42.11.15 ran locally with isolated test profiles and simulated controller input.
GPU enumeration returned AMD Radeon(TM) Graphics and Microsoft Basic Render Driver;
neither was marked active in the hidden test window. No claim is made about actual dedicated
GPU selection, 144 Hz frame pacing, physical controller latency or 4K video decoding.

Remaining measurement targets are physical-controller/fullscreen capture, large real PS3
installed-title collections, slow/removable disks and visible high-resolution wallpapers.
Per-file validation and portions of RPCS3/imported-library enumeration remain synchronous;
cooperative batching and scan reuse reduce their frequency, but a single unusually slow
filesystem operation can still delay a batch. JSON serialization remains linear in library
size, and visible wallpaper previews still decode the original media. These limits should
guide the next device profile rather than be presented as eliminated bottlenecks.
