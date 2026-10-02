import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Custom APIs for renderer
/**
 * Empty scaffold API retained for compatibility; application methods live in window.electronAPI.
 */
const api = {}
/**
 * Explicit application invoke/subscription surface. Event methods strip Electron events and
 * return cleanup functions.
 */
const localGamesAPI = {
  /**
   * Read the normalized persistent keyboard/gamepad combination. Invokes get-hotkeys; callers
   * receive its Promise result.
   */
  getHotkeys: () => ipcRenderer.invoke('get-hotkeys'),
  /**
   * Normalize and atomically persist the combination, then update the running native bridge.
   * Invokes save-hotkeys; callers receive its Promise result.
   *
   * @param {Object} hotkeys - Normalized gamepad indices and physical keyboard-code pair.
   */
  saveHotkeys: (hotkeys) => ipcRenderer.invoke('save-hotkeys', hotkeys),
  /**
   * Stop an active emulator and quit Zenith through the normal Electron lifecycle. Invokes
   * quit-app; callers receive its Promise result.
   */
  quitApp: () => ipcRenderer.invoke('quit-app'),
  /**
   * Open the native ROM picker and copy supported selections to the central library. Invokes
   * add-games; callers receive its Promise result.
   */
  addGames: () => ipcRenderer.invoke('add-games'),
  /**
   * Resolve a library ID and remove its central ROM, caches, and records after pending writers
   * settle. Invokes delete-game; callers receive its Promise result.
   *
   * @param {string} gameId - Stable library/media identity; Main resolves or validates it before accessing files.
   */
  deleteGame: (gameId) => ipcRenderer.invoke('delete-game', gameId),
  /**
   * List the trusted official/verified-local core catalog, including offline fallback status.
   * Invokes list-cores; callers receive its Promise result.
   */
  listCores: () => ipcRenderer.invoke('list-cores'),
  /**
   * Validate the game/platform target and catalog member, install it, and persist the selection
   * only on success. Invokes select-core; callers receive its Promise result.
   *
   * @param {Object} selection - Core-selection payload: gameId or platform, plus trusted core filename.
   */
  selectCore: (selection) => ipcRenderer.invoke('select-core', selection),
  /**
   * Install and physically verify the mapped platform core in the same runtime directory used by
   * launch. Invokes install-core; callers receive its Promise result.
   *
   * @param {string} platform - Platform selector; OS helpers accept win32/linux, BIOS and IPC helpers accept a library console ID.
   */
  installCore: (platform) => ipcRenderer.invoke('install-core', platform),
  /**
   * Read physical core and BIOS status for platforms currently represented in the library. Invokes
   * get-system-status; callers receive its Promise result.
   */
  getSystemStatus: () => ipcRenderer.invoke('get-system-status'),
  /**
   * Bring Zenith above an active emulator and notify the renderer to show its session panel.
   * Invokes show-session-menu; callers receive its Promise result.
   */
  showSessionMenu: () => ipcRenderer.invoke('show-session-menu'),
  /**
   * Hide the session panel and restore emulator focus if a child is still running. Invokes
   * resume-session; callers receive its Promise result.
   */
  resumeSession: () => ipcRenderer.invoke('resume-session'),
  /**
   * Request termination of the active emulator; normal exit handling restores the dashboard.
   * Invokes stop-session; callers receive its Promise result.
   */
  stopSession: () => ipcRenderer.invoke('stop-session'),
  /**
   * Return resolved runtime paths and host information for diagnostics. Invokes get-runtime-info;
   * callers receive its Promise result.
   */
  getRuntimeInfo: () => ipcRenderer.invoke('get-runtime-info'),
  /**
   * Subscribe to session-menu booleans without exposing the Electron event object. Return an
   * unsubscribe function for component cleanup.
   *
   * @param {Function} callback - Renderer callback receiving only application payloads; unsubscribe on cleanup.
   */
  onSessionMenu: (callback) => {
    /**
     * Forward only the application payload to the registered renderer callback; keep Electron event
     * objects in preload.
     *
     * @param {Object} _event - Electron invoke event; unused when no renderer notification is needed.
     * @param {boolean} open - Whether Main requests the session overlay to be shown.
     */
    const listener = (_event, open) => callback(open)
    ipcRenderer.on('session-menu', listener)
    /**
     * Unsubscribe this exact listener so closing a renderer surface does not accumulate IPC callbacks.
     */
    return () => ipcRenderer.removeListener('session-menu', listener)
  },
  /**
   * Return current library records with local protocol URLs without waiting for network scraping.
   * Invokes get-local-games; callers receive its Promise result.
   */
  getLocalGames: () => ipcRenderer.invoke('get-local-games'),
  /**
   * Return enabled guide feature flags without making network requests. Invokes
   * get-guide-features; callers receive its Promise result.
   */
  getGuideFeatures: () => ipcRenderer.invoke('get-guide-features'),
  /**
   * Resolve a library game before returning optional cached/downloaded Wikipedia lore; failures
   * yield null. Invokes get-game-lore; callers receive its Promise result.
   *
   * @param {string} gameId - Stable library/media identity; Main resolves or validates it before accessing files.
   */
  getGameLore: (gameId) => ipcRenderer.invoke('get-game-lore', gameId),
  /**
   * Return public manual title, page count, and source link, hiding provider internals from the
   * renderer. Invokes get-game-manual; callers receive its Promise result.
   *
   * @param {string} gameId - Stable library/media identity; Main resolves or validates it before accessing files.
   */
  getGameManual: (gameId) => ipcRenderer.invoke('get-game-manual', gameId),
  /**
   * Resolve a bounded manual page and register its local URL; optional-content errors yield null.
   * Invokes get-manual-page; callers receive its Promise result.
   *
   * @param {string} gameId - Stable library/media identity; Main resolves or validates it before accessing files.
   * @param {number} index - Zero-based selection, button, or page index.
   */
  getManualPage: (gameId, index) => ipcRenderer.invoke('get-manual-page', { gameId, index }),
  /**
   * Scan library artwork with progress events and queue independent preview downloads; force
   * bypasses lookup cooldowns. Invokes scan-and-scrape-games; callers receive its Promise result.
   *
   * @param {Object} options - Operation configuration; see destructured properties and defaults below.
   */
  scanAndScrapeGames: (options = {}) => ipcRenderer.invoke('scan-and-scrape-games', options),
  /**
   * Subscribe to completed per-game media records; return a disposer to prevent stale renderer
   * listeners.
   *
   * @param {Function} callback - Renderer callback receiving only application payloads; unsubscribe on cleanup.
   */
  onGameMediaUpdated: (callback) => {
    /**
     * Forward only the application payload to the registered renderer callback; keep Electron event
     * objects in preload.
     *
     * @param {Object} _event - Electron invoke event; unused when no renderer notification is needed.
     * @param {Object} game - Library game record, including identity, platform, and available local media.
     */
    const listener = (_event, game) => callback(game)
    ipcRenderer.on('game-media-updated', listener)
    /**
     * Unsubscribe this exact listener so closing a renderer surface does not accumulate IPC callbacks.
     */
    return () => {
      ipcRenderer.removeListener('game-media-updated', listener)
    }
  },
  /**
   * Subscribe to artwork scan counts and game updates; return the matching listener disposer.
   *
   * @param {Function} callback - Renderer callback receiving only application payloads; unsubscribe on cleanup.
   */
  onScrapeProgress: (callback) => {
    /**
     * Forward only the application payload to the registered renderer callback; keep Electron event
     * objects in preload.
     *
     * @param {Object} _event - Electron invoke event; unused when no renderer notification is needed.
     * @param {Object} progress - Artwork progress payload with completed/total counts and the updated game.
     */
    const listener = (_event, progress) => callback(progress)
    ipcRenderer.on('scrape-progress', listener)
    /**
     * Unsubscribe this exact listener so closing a renderer surface does not accumulate IPC callbacks.
     */
    return () => ipcRenderer.removeListener('scrape-progress', listener)
  },
  /**
   * Refuse while a game is active, delete only platform BIOS candidates, then report physical
   * status. Invokes delete-bios; callers receive its Promise result.
   *
   * @param {string} platform - Platform selector; OS helpers accept win32/linux, BIOS and IPC helpers accept a library console ID.
   */
  deleteBios: (platform) => ipcRenderer.invoke('delete-bios', platform),
  /**
   * Open the BIOS picker and copy a user-supplied dump without replacing an existing file. Invokes
   * upload-bios; callers receive its Promise result.
   *
   * @param {string} platform - Platform selector; OS helpers accept win32/linux, BIOS and IPC helpers accept a library console ID.
   */
  uploadBios: (platform) => ipcRenderer.invoke('upload-bios', platform),
  /**
   * Create and open the platform BIOS directory through the OS file manager. Invokes
   * open-bios-folder; callers receive its Promise result.
   *
   * @param {string} platform - Platform selector; OS helpers accept win32/linux, BIOS and IPC helpers accept a library console ID.
   */
  openBiosFolder: (platform) => ipcRenderer.invoke('open-bios-folder', platform),
  /**
   * Verify ROM/core/BIOS, prepare session config, spawn RetroArch, and keep the Promise pending
   * through session exit. Invokes launch-game; callers receive its Promise result.
   *
   * @param {*} gamePath - Input used by this helper; see its operation contract above.
   * @param {*} consoleType - Input used by this helper; see its operation contract above.
   */
  launchGame: (gamePath, consoleType) =>
    ipcRenderer.invoke('launch-game', { gamePath, consoleType }),
  /**
   * Subscribe to the emulator spawn signal; return an unsubscribe function.
   *
   * @param {Function} callback - Renderer callback receiving only application payloads; unsubscribe on cleanup.
   */
  onGameStarted: (callback) => {
    /**
     * Forward only the application payload to the registered renderer callback; keep Electron event
     * objects in preload.
     */
    const listener = () => callback()
    ipcRenderer.on('game-started', listener)
    /**
     * Unsubscribe this exact listener so closing a renderer surface does not accumulate IPC callbacks.
     */
    return () => ipcRenderer.removeListener('game-started', listener)
  },
  /**
   * Subscribe to session completion or launch-error resets; return an unsubscribe function.
   *
   * @param {Function} callback - Renderer callback receiving only application payloads; unsubscribe on cleanup.
   */
  onGameStopped: (callback) => {
    /**
     * Forward only the application payload to the registered renderer callback; keep Electron event
     * objects in preload.
     */
    const listener = () => callback()
    ipcRenderer.on('game-stopped', listener)
    /**
     * Unsubscribe this exact listener so closing a renderer surface does not accumulate IPC callbacks.
     */
    return () => ipcRenderer.removeListener('game-stopped', listener)
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
    contextBridge.exposeInMainWorld('electronAPI', localGamesAPI)
  } catch (error) {
    console.error(error)
  }
} else {
  window.electron = electronAPI
  window.api = api
  window.electronAPI = localGamesAPI
}
