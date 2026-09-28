import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Custom APIs for renderer
const api = {}
const localGamesAPI = {
  getHotkeys: () => ipcRenderer.invoke('get-hotkeys'),
  saveHotkeys: (hotkeys) => ipcRenderer.invoke('save-hotkeys', hotkeys),
  quitApp: () => ipcRenderer.invoke('quit-app'),
  addGames: () => ipcRenderer.invoke('add-games'),
  deleteGame: (gameId) => ipcRenderer.invoke('delete-game', gameId),
  listCores: () => ipcRenderer.invoke('list-cores'),
  selectCore: (selection) => ipcRenderer.invoke('select-core', selection),
  installCore: (platform) => ipcRenderer.invoke('install-core', platform),
  getSystemStatus: () => ipcRenderer.invoke('get-system-status'),
  showSessionMenu: () => ipcRenderer.invoke('show-session-menu'),
  resumeSession: () => ipcRenderer.invoke('resume-session'),
  stopSession: () => ipcRenderer.invoke('stop-session'),
  getRuntimeInfo: () => ipcRenderer.invoke('get-runtime-info'),
  onSessionMenu: (callback) => {
    const listener = (_event, open) => callback(open)
    ipcRenderer.on('session-menu', listener)
    return () => ipcRenderer.removeListener('session-menu', listener)
  },
  getLocalGames: () => ipcRenderer.invoke('get-local-games'),
  getGuideFeatures: () => ipcRenderer.invoke('get-guide-features'),
  getGameLore: (gameId) => ipcRenderer.invoke('get-game-lore', gameId),
  getGameManual: (gameId) => ipcRenderer.invoke('get-game-manual', gameId),
  getManualPage: (gameId, index) => ipcRenderer.invoke('get-manual-page', { gameId, index }),
  scanAndScrapeGames: (options = {}) => ipcRenderer.invoke('scan-and-scrape-games', options),
  onGameMediaUpdated: (callback) => {
    const listener = (_event, game) => callback(game)
    ipcRenderer.on('game-media-updated', listener)
    return () => {
      ipcRenderer.removeListener('game-media-updated', listener)
    }
  },
  onScrapeProgress: (callback) => {
    const listener = (_event, progress) => callback(progress)
    ipcRenderer.on('scrape-progress', listener)
    return () => ipcRenderer.removeListener('scrape-progress', listener)
  },
  deleteBios: (platform) => ipcRenderer.invoke('delete-bios', platform),
  uploadBios: (platform) => ipcRenderer.invoke('upload-bios', platform),
  openBiosFolder: (platform) => ipcRenderer.invoke('open-bios-folder', platform),
  launchGame: (gamePath, consoleType) =>
    ipcRenderer.invoke('launch-game', { gamePath, consoleType }),
  onGameStarted: (callback) => {
    const listener = () => callback()
    ipcRenderer.on('game-started', listener)
    return () => ipcRenderer.removeListener('game-started', listener)
  },
  onGameStopped: (callback) => {
    const listener = () => callback()
    ipcRenderer.on('game-stopped', listener)
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
