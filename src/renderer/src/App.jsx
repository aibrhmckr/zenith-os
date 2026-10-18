import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react'
import { createGamepadHotkey, keyboardCode } from '../../shared/hotkeys'
import { CONSOLE_EXTENSIONS } from '../../shared/consoles'
import useGameLibrary from './hooks/useGameLibrary'
import useMediaPreview from './hooks/useMediaPreview'
import useSoundEffects from './hooks/useSoundEffects'
import useController from './hooks/useController'
import useClock from './hooks/useClock'
import useDownloads from './hooks/useDownloads'
import DownloadCenter, { NotificationClearButton } from './components/DownloadCenter'
import useGridColumns from './hooks/useGridColumns'
import usePreferences from './hooks/usePreferences'
import useWallpapers from './hooks/useWallpapers'
import useFilePicker from './hooks/useFilePicker'
import { wallpaperGameMedia } from '../../shared/wallpapers'
import WallpaperVisual from './components/WallpaperVisual'
import WallpaperGallery from './components/WallpaperGallery'
import { useI18n } from './hooks/i18n'
import { InputContext } from './hooks/inputContext'
import GuideDrawer from './components/GuideDrawer'
import OnScreenKeyboard from './components/OnScreenKeyboard'
import ConsoleModal from './components/ConsoleModal'
import CoreBrowser from './components/CoreBrowser'
import Rpcs3Status from './components/Rpcs3Status'
import SystemSettings from './components/SystemSettings'
import ConsoleIcon from './components/ConsoleIcon'
import GameSpotlight from './components/GameSpotlight'
import MenuCardContent from './components/MenuCardContent'
import SettingsIcon from './components/SettingsIcon'
import InputHint, { KeyBadge } from './components/InputHint'

/** Keep controller glow visible when a hidden/restored Electron window omits native focus events. */
function markDockFocus(target) {
  document
    .querySelectorAll('[data-action-dock] > button, [data-action-dock] > .dock-search')
    .forEach((segment) => {
      segment.dataset.dockFocused = String(Boolean(target && segment.contains(target)))
    })
}

/** Move within measured grid columns; incomplete final rows clamp to the last card. */
const moveIndex = (index, direction, total, columns) => {
  if (!total) return 0
  if (direction === 'right') return Math.min(total - 1, index + 1)
  if (direction === 'left') return Math.max(0, index - 1)
  if (direction === 'up') return index >= columns ? index - columns : index
  if (direction === 'down' && Math.floor(index / columns) < Math.floor((total - 1) / columns))
    return Math.min(total - 1, index + columns)
  if (direction === 'up') return index >= columns ? index - columns : index
  if (direction === 'down')
    return (Math.floor(index / columns) + 1) * columns < total
      ? Math.min(total - 1, index + columns)
      : index
  return index
}
/**
 * Compose library, input, preview, and modal state for the fullscreen dashboard. Route
 * controller frames exclusively to the topmost dialog before dashboard actions.
 */
export default function App() {
  const { t } = useI18n()
  const {
    games,
    loading,
    error,
    scanning,
    progress,
    warning,
    refresh,
    rescrapeGame,
    rescraping,
    removeFromState
  } = useGameLibrary()
  const { preferences, togglePreference, saveHotkeys } = usePreferences()
  const filePicker = useFilePicker()
  const wallpapers = useWallpapers(filePicker.pick)
  const launchEpoch = useRef(0)
  const [failedBackground, setFailedBackground] = useState({})
  const { play: playSound } = useSoundEffects(preferences.menuSounds)
  /**
   * Scroll viewport for the fixed-size, expanding two-row game grid.
   */
  const gridRef = useRef(null)
  const columns = useGridColumns(gridRef)
  const clock = useClock()
  const downloads = useDownloads()
  const activeDownloads = downloads.filter((task) => task.status === 'active').length
  const [notificationsSeenAt, setNotificationsSeenAt] = useState(0)
  const unreadNotifications = downloads.some(
    (task) =>
      task.updatedAt > notificationsSeenAt &&
      task.status !== 'active' &&
      task.scope !== 'software-update'
  )
  /**
   * Stateful chord recognizer persists across renders and defers individual button actions until
   * release.
   */
  const hotkeyInput = useRef(createGamepadHotkey())
  /**
   * Requested card index and console choice. focusedIndex clamps selection when filters or library
   * contents shrink.
   */
  const [currentIndex, setCurrentIndex] = useState(0),
    [consoleChoice, setSelectedConsole] = useState('ALL')
  /**
   * Committed search text, OSK draft text, and visibility are separate so OSK typing cannot move
   * background card focus.
   */
  const [searchQuery, setSearchQuery] = useState(''),
    [searchDraft, setSearchDraft] = useState(''),
    [oskOpen, setOskOpen] = useState(false)
  /**
   * The guide target and typed panel determine exclusive input ownership; busy locks asynchronous
   * panel actions.
   */
  const [guideGame, setGuideGame] = useState(null),
    [panel, setPanel] = useState(null),
    [busy, setBusy] = useState(false)
  /**
   * Success and failure messages are cleared at the start of each operation rather than leaking
   * into another panel.
   */
  const [notice, setNotice] = useState(''),
    [operationError, setOperationError] = useState('')
  /**
   * Launch phase/title drives animation and preview gating; previewEnabled also tracks pointer
   * intent.
   */
  const [launchState, setLaunchState] = useState(null),
    [previewEnabled, setPreviewEnabled] = useState(true)
  /**
   * DOM focus targets and synchronous guards survive renders: selected card/search, active game,
   * launch/OSK locks, and return targets for modal dismissal.
   */
  const selectedCardRef = useRef(null),
    searchInputRef = useRef(null),
    activeGameRef = useRef(null),
    launchBusyRef = useRef(false),
    restoreFocus = useRef(false),
    returnGame = useRef(null),
    panelReturnCard = useRef(null),
    oskRef = useRef(false)
  /**
   * Only platforms present in the library plus ALL appear in the filter; this list also drives
   * shoulder-button cycling.
   */
  const consoles = useMemo(
    () => [
      'ALL',
      ...Object.keys(CONSOLE_EXTENSIONS).filter(
        /**
         * Retain only Object.keys(CONSOLE_EXTENSIONS) entries satisfying consoles's local predicate; excluded values do not reach the next stage.
         *
         * @param {*} system - Value supplied by the enclosing operation; interpreted in this callback's local scope.
         */
        (system) =>
          games.some(
            /**
             * Short-circuit when any games entry meets consoles's condition.
             *
             * @param {*} game - Value supplied by the enclosing operation; interpreted in this callback's local scope.
             */
            (game) => game.systemShort === system
          )
      )
    ],
    [games]
  )
  const selectedConsole = consoles.includes(consoleChoice) ? consoleChoice : 'ALL'
  // Counts describe the complete library, independent of the active text/platform filter.
  const consoleCounts = useMemo(() => {
    const counts = { ALL: games.length }
    for (const game of games) counts[game.systemShort] = (counts[game.systemShort] || 0) + 1
    return counts
  }, [games])
  const filteredGames = games.filter(
    /**
     * Retain only games entries satisfying filteredGames's local predicate; excluded values do not reach the next stage.
     *
     * @param {*} game - Value supplied by the enclosing operation; interpreted in this callback's local scope.
     */
    (game) =>
      (selectedConsole === 'ALL' || game.systemShort === selectedConsole) &&
      game.title.toLowerCase().includes(searchQuery.toLowerCase())
  )
  /**
   * Safe selected index after filtering; an empty library still uses zero without dereferencing a
   * missing game.
   */
  const focusedIndex = Math.min(currentIndex, Math.max(0, filteredGames.length - 1))
  const activeGame = filteredGames[focusedIndex] || null
  const gameBackground = wallpaperGameMedia(activeGame, wallpapers.onlyCustom, failedBackground)
  const {
    videoRef,
    audioRef,
    cinematic,
    stop: stopPreview,
    restart: restartPreview,
    fadeOut
  } = useMediaPreview(
    activeGame ? { ...activeGame, videoUrl: gameBackground.video } : null,
    previewEnabled &&
      !wallpapers.onlyCustom &&
      (!launchState || launchState.phase === 'fading') &&
      !guideGame &&
      !panel &&
      !oskOpen,
    preferences.previewSound && !wallpapers.onlyCustom,
    wallpapers.onlyCustom
  )
  /**
   * Keep the synchronous active-game reference current for stable launch/guide callbacks.
   */
  useEffect(() => {
    activeGameRef.current = activeGame
  }, [activeGame])
  /**
   * Scroll the selected card into view and retain card focus after grid width or selection
   * changes.
   */
  useEffect(() => {
    gridRef.current?.scrollTo({
      top: Math.max(0, Math.floor(focusedIndex / columns) - 1) * 232,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'
    })
    if (document.activeElement?.matches('[data-game-card]'))
      selectedCardRef.current?.focus({ preventScroll: true })
  }, [activeGame?.id, focusedIndex, columns])
  /**
   * Restore card/search focus after the OSK is removed from the modal top layer.
   */
  useLayoutEffect(() => {
    if (!oskOpen && restoreFocus.current) {
      restoreFocus.current = false
      ;(selectedCardRef.current || searchInputRef.current)?.focus({ preventScroll: true })
    }
  }, [oskOpen])
  /**
   * Capture the originating game card, stop previews, clear operation messages, and open a typed
   * console panel.
   *
   * @param {*} value - Input value being normalized, displayed, or committed by this helper.
   */
  const openPanel = useCallback(
    (value) => {
      if (value.type === 'downloads') setNotificationsSeenAt(Date.now())
      if (value.game) {
        panelReturnCard.current =
          Array.from(document.querySelectorAll('[data-game-card]')).find(
            /**
             * Select the first matching Array.from(document.querySelectorAll('[data-game-card]')) entry for openPanel; absence is handled by the caller's fallback.
             *
             * @param {*} card - Value supplied by the enclosing operation; interpreted in this callback's local scope.
             */
            (card) => card.dataset.gameId === value.game.id
          ) || selectedCardRef.current
      } else if (!document.querySelector('dialog[open]'))
        panelReturnCard.current = selectedCardRef.current
      stopPreview()
      setOperationError('')
      setNotice('')
      setPanel(value)
    },
    [stopPreview]
  )
  /**
   * Dismiss an idle panel or return to its parent screen; closing a session overlay also resumes
   * the emulator.
   */
  const closePanel = () => {
    if (busy) return
    playSound('back')
    if (panel?.type === 'platform') {
      setPanel({ type: 'options', game: panel.game })
      return
    }
    if (panel?.type === 'coreBrowser') {
      setPanel(
        panel.game
          ? { type: 'core', game: panel.game, platform: panel.platform }
          : { type: 'systems' }
      )
      return
    }
    if (['systems', 'wallpapers'].includes(panel?.type)) {
      setPanel({ type: 'settings' })
      return
    }
    if (panel?.type === 'deleteBios') {
      setPanel({ type: 'systems' })
      return
    }
    if (panel?.type === 'session') void window.electronAPI.resumeSession()
    setPanel(null)
  }
  /**
   * Return focus to the originating card after all blocking panels close.
   */
  useLayoutEffect(() => {
    if (!panel && !guideGame && !oskOpen) {
      const card = panelReturnCard.current?.isConnected
        ? panelReturnCard.current
        : selectedCardRef.current
      panelReturnCard.current = null
      card?.focus({ preventScroll: true })
    }
  }, [panel, guideGame, oskOpen])
  /**
   * Previous drawer-open state prevents toggle SFX from replaying on unrelated renders.
   */
  const priorGuide = useRef(false)
  /**
   * Play one toggle sound per guide open/close transition.
   */
  useEffect(() => {
    if (!!guideGame !== priorGuide.current) playSound(guideGame ? 'toggle' : 'back')
    priorGuide.current = !!guideGame
  }, [guideGame, playSound])
  /**
   * Close the selected game's guide; the focus-restoration effect returns control to the
   * dashboard.
   */
  const closeGuide = useCallback(() => setGuideGame(null), [])
  /**
   * Toggle the guide only when a game is selected and no launch, OSK, or console modal owns input.
   */
  const toggleGuide = useCallback(() => {
    if (guideGame) {
      setGuideGame(null)
      return
    }
    if (
      !activeGameRef.current ||
      launchBusyRef.current ||
      oskRef.current ||
      document.querySelector('[data-console-modal][open]')
    )
      return
    stopPreview()
    setGuideGame(activeGameRef.current)
  }, [guideGame, stopPreview])
  /**
   * Subscribe to Main session events and dispose each subscription on unmount.
   */
  useEffect(() => {
    const loading = window.electronAPI.onGameLoading(() => {
      launchEpoch.current++
      launchBusyRef.current = true
      setLaunchState({ phase: 'starting', title: activeGameRef.current?.title || '' })
    })
    const a = window.electronAPI.onGameStarted(
      /**
       * Consume onGameStarted application payloads in a; the enclosing effect disposes the IPC subscription on unmount.
       */
      () =>
        setLaunchState(
          /**
           * Compute a's next React state from the latest queued value, avoiding stale render snapshots.
           *
           * @param {*} state - Value supplied by the enclosing operation; interpreted in this callback's local scope.
           */
          (state) => (state ? { ...state, phase: 'running' } : null)
        )
    )
    const b = window.electronAPI.onGameStopped(
      /**
       * Consume onGameStopped application payloads in b; the enclosing effect disposes the IPC subscription on unmount.
       */
      () => {
        launchBusyRef.current = false
        setLaunchState(null)
        setPanel(
          /**
           * Compute b's next React state from the latest queued value, avoiding stale render snapshots.
           *
           * @param {*} p - Value supplied by the enclosing operation; interpreted in this callback's local scope.
           */
          (p) => (p?.type === 'session' ? null : p)
        )
      }
    )
    const c = window.electronAPI.onSessionMenu(
      /**
       * Consume onSessionMenu application payloads in c; the enclosing effect disposes the IPC subscription on unmount.
       *
       * @param {*} open - Value supplied by the enclosing operation; interpreted in this callback's local scope.
       */
      (open) => {
        if (open) setPanel({ type: 'session' })
        else
          setPanel(
            /**
             * Compute c's next React state from the latest queued value, avoiding stale render snapshots.
             *
             * @param {*} p - Value supplied by the enclosing operation; interpreted in this callback's local scope.
             */
            (p) => (p?.type === 'session' ? null : p)
          )
      }
    )
    /**
     * Release the listeners, timers, or focus ownership acquired by App's effect before it reruns or unmounts.
     */
    return () => {
      loading()
      a()
      b()
      c()
    }
  }, [])
  /**
   * Play the launch effect and await the 500-ms preview fade before invoking Main. Convert
   * missing-core/BIOS results to recoverable panels and release the launch lock in finally.
   *
   * @param {Object} game - Library game record, including identity, platform, and available local media.
   */
  const launch = useCallback(
    async (game = activeGameRef.current) => {
      if (!game || launchBusyRef.current) return
      const epoch = ++launchEpoch.current
      launchBusyRef.current = true
      setOperationError('')
      setLaunchState({ phase: 'fading', title: game.title })
      try {
        playSound('launch')
        await fadeOut()
        setLaunchState({ phase: 'starting', title: game.title })
        const result = await window.electronAPI.launchGame(game.path, game.systemShort)
        if (!result.success) {
          if (result.platform === 'PS3' && result.status)
            setPanel({ type: 'rpcs3', game, status: result.status })
          else if (['missing_core', 'missing_bios'].includes(result.error))
            setPanel({
              type: result.error === 'missing_core' ? 'core' : 'bios',
              platform: result.platform,
              game,
              missing: result.missing
            })
          else
            setOperationError(
              result.crash
                ? t('crash_' + result.error)
                : result.platform === 'PS3'
                  ? t(result.error)
                  : result.error || t('error')
            )
        }
      } catch {
        setOperationError(t('error'))
      } finally {
        if (epoch === launchEpoch.current) {
          launchBusyRef.current = false
          setLaunchState(null)
        }
      }
    },
    [fadeOut, playSound, t]
  )
  /**
   * Serialize a panel operation, expose cancellation/errors, and await its success continuation
   * before unlocking controls.
   *
   * @param {Function|string} action - Asynchronous IPC action, or a BIOS operation selector in useBiosManager.
   * @param {Function} after - Optional success continuation awaited before controls are unlocked.
   */
  const run = async (action, after) => {
    if (busy) return
    setBusy(true)
    setOperationError('')
    setNotice('')
    try {
      const result = await action()
      if (result.canceled) return
      if (!result.success) throw Error(result.error || t('error'))
      await after?.(result)
    } catch (error) {
      setOperationError(error.message)
    } finally {
      setBusy(false)
    }
  }
  /**
   * Invoke the native importer, then close the panel and rescan the central library without
   * forcing fresh media requests.
   */
  const addGames = () =>
    run(
      /**
       * Perform one addGames operation or its success continuation under the parent's busy/error handling.
       */
      async () => {
        const tokens = await filePicker.pick('games')
        return tokens ? window.electronAPI.addGames(tokens) : { canceled: true }
      },
      /**
       * Perform one addGames operation or its success continuation under the parent's busy/error handling.
       */
      async () => {
        setPanel(null)
        setCurrentIndex(0)
        await refresh(false)
      }
    )
  /**
   * Install the panel's missing platform core and retry the pending game launch only after a
   * successful installation.
   */
  const install = () =>
    run(
      /**
       * Perform one install operation or its success continuation under the parent's busy/error handling.
       */
      () => window.electronAPI.installCore(panel.platform),
      /**
       * Perform one install operation or its success continuation under the parent's busy/error handling.
       */
      () => {
        const game = panel.game
        setPanel(null)
        if (game) void launch(game)
      }
    )
  /**
   * Execute the already-confirmed deletion, remove its React record, and refresh selection/library
   * state after Main finishes cleanup.
   */
  const removeGame = () =>
    run(
      /**
       * Perform one removeGame operation or its success continuation under the parent's busy/error handling.
       */
      () => window.electronAPI.deleteGame(panel.game.gameId),
      /**
       * Perform one removeGame operation or its success continuation under the parent's busy/error handling.
       */
      async () => {
        removeFromState(panel.game.gameId)
        setPanel(null)
        setCurrentIndex(0)
        await refresh(false)
      }
    )
  /**
   * Ignore background navigation while a modal, keyboard, or launch owns input; move the selected
   * card and play navigation feedback only on actual movement.
   *
   * @param {string} direction - Navigation direction: up, down, left, or right.
   */
  const navigate = useCallback(
    (direction) => {
      if (launchBusyRef.current || oskRef.current || document.querySelector('dialog[open]')) return
      if (direction === 'up' && focusedIndex < columns) {
        const target = document.querySelector('[data-action-dock] [data-dock-item]')
        markDockFocus(target)
        target?.focus({ preventScroll: true })
        return
      }
      markDockFocus(null)
      selectedCardRef.current?.focus({ preventScroll: true })
      setPreviewEnabled(true)
      const next = moveIndex(focusedIndex, direction, filteredGames.length, columns)
      setCurrentIndex(next)
    },
    [focusedIndex, filteredGames.length, columns]
  )
  /**
   * Cycle through consoles represented in the library and reset card selection to the first
   * filtered result.
   *
   * @param {number} step - Signed relative movement, normally -1 or +1.
   */
  const changeConsole = (step) => {
    setSelectedConsole(
      /**
       * Compute changeConsole's next React state from the latest queued value, avoiding stale render snapshots.
       *
       * @param {*} system - Value supplied by the enclosing operation; interpreted in this callback's local scope.
       */
      (system) => consoles[(consoles.indexOf(system) + step + consoles.length) % consoles.length]
    )
    setCurrentIndex(0)
    playSound('navigate')
  }
  /**
   * Open the OSK only for explicit gamepad search, preserving the selected game and a draft query
   * for focus restoration.
   *
   * @param {string} inputMode - Last active input device; only gamepad may open the OSK.
   */
  const openKeyboard = (inputMode) => {
    if (inputMode !== 'gamepad' || oskRef.current || launchBusyRef.current) return
    returnGame.current = activeGame?.id
    setSearchDraft(searchQuery)
    oskRef.current = true
    stopPreview()
    setOskOpen(true)
  }
  /**
   * Commit the search draft, choose the prior game when still present, and restore card/input
   * focus after the OSK unmounts.
   */
  const closeKeyboard = () => {
    playSound('back')
    document.querySelector('[data-osk]')?.close()
    const results = games.filter(
      /**
       * Retain only games entries satisfying results's local predicate; excluded values do not reach the next stage.
       *
       * @param {*} game - Value supplied by the enclosing operation; interpreted in this callback's local scope.
       */
      (game) =>
        (selectedConsole === 'ALL' || game.systemShort === selectedConsole) &&
        game.title.toLowerCase().includes(searchDraft.toLowerCase())
    )
    setSearchQuery(searchDraft)
    setCurrentIndex(
      Math.max(
        0,
        results.findIndex(
          /**
           * Locate the matching results entry by index so closeKeyboard can maintain selection without retaining a stale DOM reference.
           *
           * @param {*} game - Value supplied by the enclosing operation; interpreted in this callback's local scope.
           */
          (game) => game.id === returnGame.current
        )
      )
    )
    oskRef.current = false
    restoreFocus.current = true
    setOskOpen(false)
  }
  /**
   * Leave the physical search input and return DOM focus to the selected card.
   */
  const goBack = () => {
    markDockFocus(null)
    searchInputRef.current?.blur()
    selectedCardRef.current?.focus()
  }
  /** Clear the committed filter and draft together, then restore the first visible card. */
  const clearSearch = useCallback(() => {
    markDockFocus(null)
    setSearchQuery('')
    setSearchDraft('')
    setCurrentIndex(0)
    requestAnimationFrame(() => selectedCardRef.current?.focus({ preventScroll: true }))
  }, [])
  /** The dock owns horizontal navigation; down/B returns to the selected game without launching. */
  const moveDock = useCallback((direction) => {
    if (direction === 'down') {
      markDockFocus(null)
      selectedCardRef.current?.focus({ preventScroll: true })
      return
    }
    if (!['left', 'right'].includes(direction)) return
    const items = [
      ...document.querySelectorAll('[data-action-dock] [data-dock-item]:not(:disabled)')
    ]
    const index = Math.max(
      0,
      items.findIndex(
        (item) =>
          item === document.activeElement ||
          (item === searchInputRef.current && document.activeElement?.closest('.dock-search'))
      )
    )
    const target =
      items[Math.max(0, Math.min(items.length - 1, index + (direction === 'right' ? 1 : -1)))]
    markDockFocus(target)
    target?.focus({ preventScroll: true })
  }, [])
  /**
   * Bind dashboard keyboard actions with the latest selection and callbacks; remove the listener
   * before rebinding.
   */
  useEffect(() => {
    /**
     * Handle dashboard keyboard shortcuts only outside text fields and dialogs; prevent native key
     * behavior when a dashboard action consumes the event.
     *
     * @param {Object} event - Electron or DOM event associated with this operation.
     */
    const input = (event) => {
      if (
        document.querySelector('dialog[open]') ||
        launchBusyRef.current ||
        event.target.closest('input,select,textarea')
      )
        return
      const direction = {
        ArrowUp: 'up',
        ArrowDown: 'down',
        ArrowLeft: 'left',
        ArrowRight: 'right'
      }[event.key]
      if (direction) {
        event.preventDefault()
        if (event.target.closest('[data-action-dock]')) moveDock(direction)
        else navigate(direction)
      } else if (event.key === '/') {
        event.preventDefault()
        searchInputRef.current?.focus()
      } else if (searchQuery && ['x', 'backspace'].includes(event.key.toLowerCase())) {
        event.preventDefault()
        clearSearch()
      } else if (event.key.toLowerCase() === 'd') {
        event.preventDefault()
        openPanel({ type: 'downloads' })
      } else if (event.key.toLowerCase() === 'h') {
        event.preventDefault()
        if (!event.repeat) toggleGuide()
      } else if (['q', 'o'].includes(event.key.toLowerCase()) && activeGameRef.current) {
        event.preventDefault()
        openPanel({ type: 'options', game: activeGameRef.current })
      } else if (event.key.toLowerCase() === 'f') {
        event.preventDefault()
        openPanel({ type: 'filter' })
      } else if (event.key.toLowerCase() === 'm' && !event.repeat) {
        event.preventDefault()
        togglePreference('previewSound')
      } else if (event.key.toLowerCase() === 'r' && !event.repeat) {
        event.preventDefault()
        document.querySelector('[data-refresh-library]')?.click()
      } else if (event.key === 'ContextMenu') {
        event.preventDefault()
        openPanel({ type: 'settings' })
      } else if (event.key === '+' || event.key === 'Insert') {
        event.preventDefault()
        document.querySelector('[data-add-game]')?.click()
      } else if (event.key === 'Delete' && activeGameRef.current) {
        event.preventDefault()
        openPanel({ type: 'delete', game: activeGameRef.current })
      } else if (event.key === 'Escape') goBack()
      else if (
        event.key === 'Enter' &&
        !event.repeat &&
        !event.target.closest('button:not([data-game-card]):not([data-launch-game])')
      ) {
        event.preventDefault()
        void launch()
      } else if (['PageUp', 'PageDown'].includes(event.key)) {
        event.preventDefault()
        const step = event.key === 'PageDown' ? 1 : -1
        setSelectedConsole(
          /**
           * Compute input's next React state from the latest queued value, avoiding stale render snapshots.
           *
           * @param {*} system - Value supplied by the enclosing operation; interpreted in this callback's local scope.
           */
          (system) =>
            consoles[(consoles.indexOf(system) + step + consoles.length) % consoles.length]
        )
        setCurrentIndex(0)
      }
    }
    window.addEventListener('keydown', input)
    /**
     * Release the listeners, timers, or focus ownership acquired by App's effect before it reruns or unmounts.
     */
    return () => window.removeEventListener('keydown', input)
  }, [
    launch,
    navigate,
    moveDock,
    openPanel,
    toggleGuide,
    togglePreference,
    consoles,
    searchQuery,
    clearSearch
  ])
  /**
   * Capture exit chords before ordinary shortcuts; clear held keys on blur and remove all
   * listeners on cleanup.
   */
  useEffect(() => {
    const held = new Set()
    let fired = false
    /**
     * Track held physical keys in capture phase; trigger one Zenith menu per chord and consume
     * conflicting individual shortcuts.
     *
     * @param {Object} event - Electron or DOM event associated with this operation.
     */
    const down = (event) => {
      if (document.querySelector('dialog[open]') || event.target.closest('input,textarea,select'))
        return
      const code = keyboardCode(event)
      held.add(code)
      const pair = preferences.hotkeys.keyboard
      const matches =
        ['Escape', 'F10'].includes(code) ||
        (pair.length === 2 &&
          pair.every(
            /**
             * Require every pair entry to satisfy matches's invariant before continuing.
             *
             * @param {*} key - Value supplied by the enclosing operation; interpreted in this callback's local scope.
             */
            (key) => held.has(key)
          ))
      if (matches || pair.includes(code)) {
        event.preventDefault()
        event.stopImmediatePropagation()
      }
      if (matches && !fired && !event.repeat) {
        fired = true
        if (launchBusyRef.current) void window.electronAPI.showSessionMenu()
        else openPanel({ type: 'mainMenu' })
      }
    }
    /**
     * Release a held physical key and rearm combination detection after keyup.
     *
     * @param {Object} event - Electron or DOM event associated with this operation.
     */
    const up = (event) => {
      held.delete(keyboardCode(event))
      fired = false
    }
    /**
     * Clear held keys on window blur so a lost keyup cannot leave the exit combination stuck.
     */
    const reset = () => {
      held.clear()
      fired = false
    }
    window.addEventListener('keydown', down, true)
    window.addEventListener('keyup', up, true)
    window.addEventListener('blur', reset)
    /**
     * Release the listeners, timers, or focus ownership acquired by App's effect before it reruns or unmounts.
     */
    return () => {
      window.removeEventListener('keydown', down, true)
      window.removeEventListener('keyup', up, true)
      window.removeEventListener('blur', reset)
    }
  }, [preferences.hotkeys, openPanel])
  const { mode, controller } = useController(
    /**
     * Route one normalized controller frame to the topmost modal, exit chord, or dashboard action in that order; returning early prevents background input leakage.
     *
     * @param {*} frame - Normalized controller frame with edge helpers, buttons, axes, and timestamp.
     */
    (frame) => {
      const surface = Array.from(document.querySelectorAll('dialog[open]')).at(-1)
      const chord = hotkeyInput.current(frame, preferences.hotkeys.gamepad, Boolean(surface))
      const hit = chord.hit
      const directionButton = { up: 12, down: 13, left: 14, right: 15 }[frame.move]
      const releasedDirection = Object.entries({ up: 12, down: 13, left: 14, right: 15 }).find(
        /**
         * Select the first matching Object.entries({ up: 12, down: 13, left: 14, right: 15 }) entry for releasedDirection; absence is handled by the caller's fallback.
         *
         * @param {*} input1 - Value supplied by the enclosing operation; interpreted in this callback's local scope.
         */
        ([, index]) => preferences.hotkeys.gamepad.includes(index) && hit(index)
      )?.[0]
      const move =
        releasedDirection ||
        (preferences.hotkeys.gamepad.includes(directionButton) ? null : frame.move)
      if (surface) {
        surface.dispatchEvent(new CustomEvent('controller-input', { detail: frame }))
        return
      }
      if (chord.triggered || frame.hit(16)) {
        if (launchBusyRef.current) void window.electronAPI.showSessionMenu()
        else openPanel({ type: 'mainMenu' })
        return
      }
      if (launchBusyRef.current || oskRef.current || guideGame || panel) return
      if (hit(3)) {
        openKeyboard(frame.inputMode)
        return
      }
      if (hit(2) && searchQuery) {
        clearSearch()
        return
      }
      if (hit(2) && activeGame) {
        openPanel({ type: 'options', game: activeGame })
        return
      }
      if (hit(6)) {
        document.querySelector('[data-refresh-library]')?.click()
        return
      }
      if (hit(7)) {
        document.querySelector('[data-downloads-trigger]')?.focus()
        openPanel({ type: 'downloads' })
        return
      }
      if (hit(8)) {
        openPanel({ type: 'filter' })
        return
      }
      if (hit(9)) {
        openPanel({ type: 'settings' })
        return
      }
      if (hit(10) && activeGame) {
        openPanel({ type: 'delete', game: activeGame })
        return
      }
      if (hit(11)) {
        void addGames()
        return
      }
      if (hit(1)) {
        goBack()
        return
      }
      if (hit(4) || hit(5)) {
        changeConsole(hit(5) ? 1 : -1)
        return
      }
      if (document.activeElement?.closest('[data-action-dock]')) {
        if (move) moveDock(move)
        else if (hit(0)) {
          if (
            document.activeElement?.closest('.dock-search') &&
            !document.activeElement?.closest('[data-clear-search]')
          )
            openKeyboard(frame.inputMode)
          else document.activeElement.click()
        }
        return
      }
      if (hit(0)) {
        void launch()
        return
      }
      if (move) navigate(move)
    }
  )
  return (
    <InputContext.Provider value={mode}>
      <div data-input-mode={mode} className="zenith-shell">
        <div className="wallpaper-background" data-wallpaper-background={wallpapers.selectedId}>
          <WallpaperVisual
            wallpaper={wallpapers.selected}
            playing={
              !gameBackground.image &&
              !(cinematic && gameBackground.video) &&
              !launchState &&
              !panel
            }
          />
        </div>
        {gameBackground.image && (
          <img
            className={
              'hero-fixed-image transition-opacity duration-700 ' +
              (cinematic && gameBackground.video ? 'opacity-0' : 'opacity-100')
            }
            src={gameBackground.image}
            onError={() =>
              setFailedBackground((current) => ({ ...current, image: gameBackground.image }))
            }
            alt=""
          />
        )}
        <video
          ref={videoRef}
          key={gameBackground.video || 'video'}
          src={gameBackground.video || undefined}
          onError={() =>
            setFailedBackground((current) => ({ ...current, video: gameBackground.video }))
          }
          loop
          playsInline
          preload="none"
          className={
            'hero-fixed-image ' + (cinematic && gameBackground.video ? 'opacity-100' : 'opacity-0')
          }
          aria-hidden="true"
        />
        <audio
          ref={audioRef}
          key={activeGame?.musicUrl || 'audio'}
          src={activeGame?.musicUrl || undefined}
          loop
          preload="none"
        />
        <div data-cinematic={cinematic} className="dashboard-shading" />
        <div data-spotlight-vignette className="spotlight-vignette" aria-hidden="true" />
        <header className="dashboard-header relative z-20 flex shrink-0 items-center justify-between py-5">
          <div className="font-black tracking-[.3em] text-lg">
            ZENITH<span className="ml-2 font-light text-white/45">OS</span>
          </div>
          <div className="system-dock" data-system-dock>
            {controller && (
              <span data-controller-status className="system-controller">
                P1 <span className="system-controller-light" />
                {controller.battery !== null && (
                  <span data-controller-battery>{controller.battery}%</span>
                )}
              </span>
            )}
            <button
              data-downloads-trigger
              aria-label={t('downloads')}
              aria-haspopup="dialog"
              onClick={() => {
                setNotificationsSeenAt(Date.now())
                openPanel({ type: 'downloads' })
              }}
              className="relative console-button header-control"
            >
              <svg
                className={activeDownloads ? 'animate-pulse' : ''}
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden="true"
              >
                <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4M12 2V1" />
              </svg>
              <InputHint gamepad="RT" keyboard="D" />
              {(activeDownloads > 0 || unreadNotifications) && (
                <span data-downloads-badge className="notification-dot">
                  <span className="sr-only">{activeDownloads}</span>
                </span>
              )}
            </button>
            <button
              data-settings-trigger
              className="header-control"
              onClick={
                /**
                 * Handle onClick on this App control using the current render's values; delegate state/IPC work to its owning component.
                 */
                () => openPanel({ type: 'settings' })
              }
            >
              <SettingsIcon name="settings" />
              <InputHint keyboard="Menu" gamepad="Menu">
                {t('settings')}
              </InputHint>
            </button>
            <time data-system-clock className="system-clock">
              {clock}
            </time>
          </div>
        </header>
        <main data-spotlight-host className="dashboard-hero relative z-10 flex-1">
          {activeGame ? (
            <GameSpotlight key={activeGame.id} activeGame={activeGame} />
          ) : (
            <p className="py-6 text-white/60">
              {loading
                ? t('loading')
                : error
                  ? t('libraryError')
                  : games.length
                    ? t('noResults')
                    : t('empty')}
            </p>
          )}
        </main>
        {!panel && operationError && (
          <p role="alert" className="relative z-10 px-10 text-rose-200">
            {operationError}
          </p>
        )}
        <section
          data-columns={columns}
          data-expanded={focusedIndex >= columns}
          data-focused-row={Math.floor(focusedIndex / columns)}
          className="dashboard-library safe-zone relative z-10 flex flex-col"
        >
          <div
            data-action-dock
            role="group"
            aria-label={t('libraryActions')}
            className="dashboard-toolbar mb-3"
            onFocusCapture={(event) => {
              markDockFocus(event.target)
              playSound('navigate')
            }}
            onBlurCapture={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) markDockFocus(null)
            }}
          >
            <button
              data-dock-item
              data-console-filter
              aria-controls="console-filters"
              onClick={
                /**
                 * Handle onClick on this App control using the current render's values; delegate state/IPC work to its owning component.
                 */
                () => openPanel({ type: 'filter' })
              }
              className="console-button"
            >
              <span>{selectedConsole === 'ALL' ? t('all') : selectedConsole}</span>
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden="true"
              >
                <path d="m6 9 6 6 6-6" />
              </svg>
              <KeyBadge keyboard="F" gamepad="View" />
            </button>
            <div className="dock-search">
              <svg
                className="dock-search-icon"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                aria-hidden="true"
              >
                <circle cx="10.5" cy="10.5" r="6.5" />
                <path d="m16 16 5 5" />
              </svg>
              <input
                data-dock-item
                data-search-input
                ref={searchInputRef}
                aria-label={t('search')}
                placeholder={t('searchLibrary')}
                value={searchQuery}
                onFocus={
                  /**
                   * Handle onFocus on this App control using the current render's values; delegate state/IPC work to its owning component.
                   */
                  () => {
                    stopPreview()
                    setPreviewEnabled(false)
                  }
                }
                onChange={
                  /**
                   * Handle onChange on this App control using the current render's values; delegate state/IPC work to its owning component.
                   *
                   * @param {*} e - DOM event from this control.
                   */
                  (e) => {
                    setSearchQuery(e.target.value)
                    setCurrentIndex(0)
                  }
                }
                onKeyDown={
                  /**
                   * Handle onKeyDown on this App control using the current render's values; delegate state/IPC work to its owning component.
                   *
                   * @param {*} e - DOM event from this control.
                   */
                  (e) => {
                    if (e.key === 'Escape' || e.key === 'ArrowDown') {
                      e.preventDefault()
                      goBack()
                    }
                  }
                }
                className="bg-transparent outline-none placeholder:text-white/40"
              />
              {searchQuery ? (
                <button
                  className="dock-search-action"
                  data-clear-search
                  onClick={clearSearch}
                  aria-label={t('clearSearch')}
                >
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    aria-hidden="true"
                  >
                    <path d="M9 5h12v14H9L2 12Z" />
                    <path d="m12 9 6 6m0-6-6 6" />
                  </svg>
                  <KeyBadge keyboard="X" gamepad="X" />
                  <span>{t('clear')}</span>
                </button>
              ) : (
                <button
                  className="dock-search-action"
                  data-search-trigger
                  aria-label={t('search')}
                  onClick={
                    /**
                     * Handle onClick on this App control using the current render's values; delegate state/IPC work to its owning component.
                     */
                    () => searchInputRef.current?.focus()
                  }
                >
                  <KeyBadge keyboard="/" gamepad="Y" />
                </button>
              )}
            </div>
            <button
              data-dock-item
              data-add-game
              onClick={addGames}
              disabled={loading || busy || scanning}
              className="console-button"
            >
              <KeyBadge keyboard="+" gamepad="R3" />
              {t('add')}
            </button>
            <button
              data-dock-item
              data-refresh-library
              disabled={scanning || !!launchState}
              onClick={
                /**
                 * Handle onClick on this App control using the current render's values; delegate state/IPC work to its owning component.
                 */
                () => void refresh()
              }
              className="console-button"
            >
              <KeyBadge keyboard="R" gamepad="LT" />
              {scanning
                ? t('scanning') + (progress ? ' ' + progress.completed + '/' + progress.total : '')
                : t('refresh')}
            </button>
          </div>
          {warning && (
            <p role="status" className="mb-2 text-xs text-amber-200">
              {warning}
            </p>
          )}
          <div ref={gridRef} className="poster-grid">
            {filteredGames.map(
              /**
               * Project each filteredGames entry for App; preserve input ordering in the derived collection.
               *
               * @param {*} game - Value supplied by the enclosing operation; interpreted in this callback's local scope.
               * @param {*} index - Zero-based collection index.
               */
              (game, index) => (
                <button
                  key={game.id}
                  data-game-card
                  data-game-id={game.id}
                  aria-label={game.title}
                  aria-pressed={index === focusedIndex}
                  tabIndex={index === focusedIndex ? 0 : -1}
                  ref={index === focusedIndex ? selectedCardRef : null}
                  onFocus={
                    /**
                     * Handle onFocus on this App control using the current render's values; delegate state/IPC work to its owning component.
                     */
                    () => {
                      if (oskRef.current) return
                      playSound('navigate')
                      setCurrentIndex(index)
                      setPreviewEnabled(true)
                      restartPreview()
                    }
                  }
                  onMouseEnter={
                    /**
                     * Handle onMouseEnter on this App control using the current render's values; delegate state/IPC work to its owning component.
                     */
                    (event) => {
                      if (launchBusyRef.current || oskRef.current) return
                      // Pointer, keyboard and controller share one focus-owned sound trigger.
                      if (document.activeElement === event.currentTarget) {
                        setPreviewEnabled(true)
                        restartPreview()
                      } else event.currentTarget.focus({ preventScroll: true })
                    }
                  }
                  onMouseLeave={
                    /**
                     * Handle onMouseLeave on this App control using the current render's values; delegate state/IPC work to its owning component.
                     */
                    () => {
                      stopPreview()
                      setPreviewEnabled(false)
                    }
                  }
                  onBlur={
                    /**
                     * Handle onBlur on this App control using the current render's values; delegate state/IPC work to its owning component.
                     */
                    () => {
                      if (!launchBusyRef.current) {
                        stopPreview()
                        setPreviewEnabled(false)
                      }
                    }
                  }
                  onClick={
                    /**
                     * Handle onClick on this App control using the current render's values; delegate state/IPC work to its owning component.
                     */
                    () => setCurrentIndex(index)
                  }
                  className={
                    'poster-card transition-all duration-300 ' +
                    (index === focusedIndex
                      ? 'scale-105 opacity-100 ring-2 ring-blue-500 shadow-[0_0_25px_rgba(59,130,246,0.6)]'
                      : 'opacity-80 hover:opacity-100')
                  }
                >
                  {game.coverUrl ? (
                    <img
                      src={game.coverUrl}
                      alt={game.title}
                      loading="lazy"
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="poster-fallback">
                      <ConsoleIcon platform={game.systemShort} />
                      <strong>{game.systemShort}</strong>
                      <span>{game.title}</span>
                    </div>
                  )}
                  <div className="poster-caption absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/95 to-transparent text-left">
                    <span className="text-[10px] font-bold tracking-widest text-blue-200">
                      {game.systemShort}
                    </span>
                    <p className="mt-1 text-xs font-bold line-clamp-2">{game.title}</p>
                  </div>
                </button>
              )
            )}
          </div>
        </section>
        <footer data-library-footer className="dashboard-footer relative z-20 shrink-0">
          <div className="safe-zone flex flex-wrap items-center justify-center gap-x-7 gap-y-3">
            <button
              data-launch-game
              disabled={!activeGame || !!launchState}
              onClick={
                /**
                 * Handle onClick on this App control using the current render's values; delegate state/IPC work to its owning component.
                 */
                () => void launch()
              }
            >
              <InputHint keyboard="Enter" gamepad="A">
                {t('launch')}
              </InputHint>
            </button>
            <button onClick={goBack}>
              <InputHint keyboard="Esc" gamepad="B">
                {t('back')}
              </InputHint>
            </button>
            {searchQuery ? (
              <button data-clear-search onClick={clearSearch}>
                <InputHint keyboard="X / ⌫" gamepad="X">
                  {t('clearSearch')}
                </InputHint>
              </button>
            ) : (
              <button
                data-game-options
                disabled={!activeGame}
                onClick={
                  /**
                   * Handle onClick on this App control using the current render's values; delegate state/IPC work to its owning component.
                   */
                  () => openPanel({ type: 'options', game: activeGame })
                }
              >
                <InputHint keyboard="Q" gamepad="X">
                  {t('options')}
                </InputHint>
              </button>
            )}
            <button
              onClick={
                /**
                 * Handle onClick on this App control using the current render's values; delegate state/IPC work to its owning component.
                 */
                () => searchInputRef.current?.focus()
              }
            >
              <InputHint keyboard="/" gamepad="Y">
                {t('searchAction')}
              </InputHint>
            </button>
            <span className="input-hint">
              <KeyBadge keyboard="PgUp / PgDn" gamepad="LB / RB" />
              {t('filter')}
            </span>
            <button
              onClick={
                /**
                 * Handle onClick on this App control using the current render's values; delegate state/IPC work to its owning component.
                 */
                () => openPanel({ type: 'settings' })
              }
            >
              <InputHint keyboard="Menu" gamepad="Menu">
                {t('settings')}
              </InputHint>
            </button>
          </div>
        </footer>
        {guideGame && <GuideDrawer key={guideGame.gameId} game={guideGame} onClose={closeGuide} />}
        {oskOpen && (
          <OnScreenKeyboard value={searchDraft} onChange={setSearchDraft} onClose={closeKeyboard} />
        )}
        {panel && (
          <ConsoleModal
            key={panel.type}
            kind={panel.type}
            title={t(
              {
                downloads: 'downloads',
                settings: 'settings',
                wallpapers: 'wallpaperGallery',
                systems: 'status',
                deleteBios: 'deleteBios',
                options: 'options',
                platform: 'changePlatform',
                filter: 'filter',
                delete: 'deleteTitle',
                core: 'core',
                coreBrowser: 'browseCores',
                rpcs3: 'rpcs3Setup',
                bios: 'biosMissing',
                session: 'session',
                mainMenu: 'mainMenu'
              }[panel.type]
            )}
            onClose={closePanel}
            busy={busy}
            headerActions={
              panel.type === 'downloads' ? (
                <NotificationClearButton
                  tasks={downloads}
                  onClear={() =>
                    void window.electronAPI
                      .clearDownloadHistory()
                      .catch(() => setOperationError(t('notificationClearFailed')))
                  }
                />
              ) : null
            }
          >
            {operationError && (
              <p role="alert" className="mb-4 text-rose-200">
                {operationError}
              </p>
            )}
            {notice && (
              <p role="status" className="mb-4 text-emerald-300">
                {notice}
              </p>
            )}
            {busy && (
              <p role="status" aria-live="polite" className="mb-4 animate-pulse">
                {panel.type === 'core' ? t('coreDownloading') : t('working')}
              </p>
            )}
            {panel.type === 'downloads' && (
              <DownloadCenter
                tasks={downloads}
                onOpenUpdates={() => openPanel({ type: 'settings', focus: 'software-update' })}
              />
            )}
            {panel.type === 'rpcs3' && (
              <Rpcs3Status
                status={panel.status}
                onLaunch={() => {
                  const game = panel.game
                  closePanel()
                  void launch(game)
                }}
              />
            )}
            {panel.type === 'options' && (
              <div className="flex flex-col gap-3">
                <p className="mb-3 text-xl font-bold">{panel.game.title}</p>
                <button
                  data-game-option
                  data-initial-focus
                  data-open-guide
                  className="settings-navigation-card"
                  onClick={
                    /**
                     * Handle onClick on this App control using the current render's values; delegate state/IPC work to its owning component.
                     */
                    () => {
                      setPanel(null)
                      setGuideGame(panel.game)
                    }
                  }
                >
                  <MenuCardContent
                    icon="book"
                    title={t('guide')}
                    description={t('guideCardHelp')}
                  />
                </button>
                <button
                  data-game-option
                  data-rescrape-game
                  disabled={rescraping}
                  className="settings-navigation-card"
                  onClick={() => {
                    const game = panel.game
                    closePanel()
                    void rescrapeGame(game)
                  }}
                >
                  <MenuCardContent
                    icon="update"
                    title={t('rescrapeMedia')}
                    description={t('rescrapeCardHelp')}
                  />
                </button>
                {!panel.game.rpcs3Installed && (
                  <button
                    data-game-option
                    data-change-platform
                    className="settings-navigation-card"
                    onClick={() => openPanel({ type: 'platform', game: panel.game })}
                  >
                    <MenuCardContent
                      icon="gamepad"
                      title={t('changePlatform')}
                      description={t('platformCardHelp')}
                    />
                  </button>
                )}
                <button
                  data-game-option
                  className="settings-navigation-card menu-card-danger"
                  onClick={
                    /**
                     * Handle onClick on this App control using the current render's values; delegate state/IPC work to its owning component.
                     */
                    () => openPanel({ type: 'delete', game: panel.game })
                  }
                >
                  <MenuCardContent
                    icon="trash"
                    title={t('delete')}
                    description={t('deleteCardHelp')}
                  />
                </button>
              </div>
            )}
            {panel.type === 'platform' && (
              <div data-navigation-grid className="grid grid-cols-3 gap-3">
                {[null, ...Object.keys(CONSOLE_EXTENSIONS)].map((platform) => (
                  <button
                    key={platform || 'auto'}
                    data-platform-choice={platform || 'auto'}
                    data-initial-focus={platform === null ? true : undefined}
                    disabled={busy}
                    className="console-button"
                    aria-pressed={platform === (panel.game.platformOverride || null)}
                    onClick={() =>
                      run(
                        () => window.electronAPI.setGamePlatform(panel.game.gameId, platform),
                        (result) => {
                          setSelectedConsole('ALL')
                          setPanel({ type: 'options', game: result.game })
                        }
                      )
                    }
                  >
                    {platform || t('automaticPlatform')}
                  </button>
                ))}
              </div>
            )}
            {panel.type === 'filter' && (
              <div data-navigation-grid id="console-filters" className="console-filter-grid">
                {consoles.map(
                  /**
                   * Project each consoles entry for App; preserve input ordering in the derived collection.
                   *
                   * @param {*} system - Value supplied by the enclosing operation; interpreted in this callback's local scope.
                   */
                  (system) => (
                    <button
                      key={system}
                      className="console-filter-card"
                      data-console-filter={system}
                      aria-pressed={selectedConsole === system}
                      onClick={
                        /**
                         * Handle onClick on this App control using the current render's values; delegate state/IPC work to its owning component.
                         */
                        () => {
                          setSelectedConsole(system)
                          setCurrentIndex(0)
                          setPanel(null)
                        }
                      }
                    >
                      <span className="console-filter-icon">
                        <ConsoleIcon platform={system} />
                      </span>
                      <span className="console-filter-name">
                        {system === 'ALL' ? t('all') : system}
                      </span>
                      <span
                        className="console-filter-count"
                        data-game-count={consoleCounts[system] || 0}
                      >
                        <strong>{consoleCounts[system] || 0}</strong>
                        <span>
                          {t(consoleCounts[system] === 1 ? 'gameCountOne' : 'gameCountMany')}
                        </span>
                      </span>
                    </button>
                  )
                )}
              </div>
            )}
            {panel.type === 'delete' && (
              <>
                <p className="mb-3 text-xl font-bold">{panel.game.title}</p>
                <p className="mb-6 text-white/60">{t('deleteHelp')}</p>
                <div className="flex gap-3">
                  <button className="console-button" disabled={busy} onClick={closePanel}>
                    <InputHint keyboard="Esc" gamepad="B">
                      {t('cancel')}
                    </InputHint>
                  </button>
                  <button
                    data-initial-focus
                    data-confirm-delete
                    className="console-button text-rose-200"
                    disabled={busy}
                    onClick={removeGame}
                  >
                    <InputHint keyboard="Enter" gamepad="A">
                      {t('confirm')}
                    </InputHint>
                  </button>
                </div>
              </>
            )}
            {panel.type === 'coreBrowser' && (
              <CoreBrowser
                busy={busy}
                onSelect={
                  /**
                   * Handle onSelect on this App control using the current render's values; delegate state/IPC work to its owning component.
                   *
                   * @param {*} core - Value supplied by the enclosing operation; interpreted in this callback's local scope.
                   */
                  (core) =>
                    run(
                      /**
                       * Perform one App operation or its success continuation under the parent's busy/error handling.
                       */
                      () =>
                        window.electronAPI.selectCore({
                          gameId: panel.game?.gameId,
                          platform: panel.platform,
                          core
                        }),
                      /**
                       * Perform one App operation or its success continuation under the parent's busy/error handling.
                       */
                      () => {
                        const game = panel.game
                        setPanel(game ? null : { type: 'systems' })
                        if (game) void launch(game)
                      }
                    )
                }
              />
            )}
            {panel.type === 'core' && (
              <>
                <p className="mb-6">{t('coreMissing').replace('{platform}', panel.platform)}</p>
                <div className="flex flex-wrap gap-3" aria-busy={busy}>
                  <button
                    data-download-core
                    data-initial-focus
                    disabled={busy}
                    onClick={install}
                    className="console-button"
                  >
                    {t('download')}
                  </button>
                  <button
                    data-cancel-core
                    disabled={busy}
                    onClick={closePanel}
                    className="console-button"
                  >
                    {t('cancel')}
                  </button>
                  <button
                    data-browse-cores
                    disabled={busy}
                    onClick={
                      /**
                       * Handle onClick on this App control using the current render's values; delegate state/IPC work to its owning component.
                       */
                      () => openPanel({ ...panel, type: 'coreBrowser' })
                    }
                    className="console-button"
                  >
                    {t('browseCores')}
                  </button>
                </div>
              </>
            )}
            {panel.type === 'bios' && (
              <>
                <p className="mb-3">
                  {panel.platform} · {t('biosHelp')}
                </p>
                <p className="mb-5 text-amber-200">{panel.missing?.join(', ')}</p>
                <div className="flex flex-wrap gap-3">
                  <button
                    data-upload-bios
                    disabled={busy}
                    onClick={
                      /**
                       * Handle onClick on this App control using the current render's values; delegate state/IPC work to its owning component.
                       */
                      () =>
                        run(
                          /**
                           * Perform one App operation or its success continuation under the parent's busy/error handling.
                           */
                          () => window.electronAPI.uploadBios(panel.platform),
                          /**
                           * Perform one App operation or its success continuation under the parent's busy/error handling.
                           *
                           * @param {*} result - Value supplied by the enclosing operation; interpreted in this callback's local scope.
                           */
                          (result) => {
                            setNotice(result.status?.ready ? t('ready') : t('biosNotReady'))
                            setPanel(
                              /**
                               * Compute App's next React state from the latest queued value, avoiding stale render snapshots.
                               *
                               * @param {*} p - Value supplied by the enclosing operation; interpreted in this callback's local scope.
                               */
                              (p) => ({ ...p, ready: !!result.status?.ready })
                            )
                          }
                        )
                    }
                    className="console-button"
                  >
                    {t('uploadBios')}
                  </button>
                  <button
                    disabled={busy}
                    onClick={
                      /**
                       * Handle onClick on this App control using the current render's values; delegate state/IPC work to its owning component.
                       */
                      () =>
                        run(
                          /**
                           * Perform one App operation or its success continuation under the parent's busy/error handling.
                           */
                          () => window.electronAPI.openBiosFolder(panel.platform)
                        )
                    }
                    className="console-button"
                  >
                    {t('folder')}
                  </button>
                  {panel.ready && (
                    <button
                      data-launch-after-bios
                      disabled={busy}
                      onClick={
                        /**
                         * Handle onClick on this App control using the current render's values; delegate state/IPC work to its owning component.
                         */
                        () => {
                          const game = panel.game
                          setPanel(null)
                          void launch(game)
                        }
                      }
                      className="console-button"
                    >
                      {t('restart')}
                    </button>
                  )}
                </div>
              </>
            )}
            {panel.type === 'mainMenu' && (
              <div className="flex flex-col gap-3">
                <button className="settings-navigation-card" onClick={closePanel}>
                  <MenuCardContent icon="back" title={t('back')} description={t('backCardHelp')} />
                </button>
                <button
                  className="settings-navigation-card"
                  onClick={
                    /**
                     * Handle onClick on this App control using the current render's values; delegate state/IPC work to its owning component.
                     */
                    () => openPanel({ type: 'settings' })
                  }
                >
                  <MenuCardContent
                    icon="settings"
                    title={t('settings')}
                    description={t('settingsCardHelp')}
                  />
                </button>
                <button
                  data-quit-app
                  className="settings-navigation-card menu-card-danger"
                  onClick={
                    /**
                     * Handle onClick on this App control using the current render's values; delegate state/IPC work to its owning component.
                     */
                    () => window.electronAPI.quitApp()
                  }
                >
                  <MenuCardContent icon="power" title={t('quit')} description={t('quitCardHelp')} />
                </button>
              </div>
            )}
            {panel.type === 'session' && (
              <>
                <div className="flex flex-col gap-3">
                  <button
                    data-initial-focus
                    data-session-option
                    className="settings-navigation-card"
                    onClick={closePanel}
                  >
                    <MenuCardContent icon="play" title={t('resume')} />
                  </button>
                  <button
                    data-session-option
                    className="settings-navigation-card menu-card-danger"
                    onClick={
                      /**
                       * Handle onClick on this App control using the current render's values; delegate state/IPC work to its owning component.
                       */
                      () => void window.electronAPI.stopSession()
                    }
                  >
                    <MenuCardContent icon="stop" title={t('stop')} />
                  </button>
                </div>
                <button
                  data-restart-session
                  data-session-option
                  className="settings-navigation-card"
                  onClick={async () => {
                    setPanel(null)
                    const result = await window.electronAPI.restartSession()
                    if (!result.success) {
                      launchBusyRef.current = false
                      setLaunchState(null)
                      setOperationError(result.error)
                    }
                  }}
                >
                  <MenuCardContent icon="update" title={t('restartSession')} />
                </button>
                <button
                  data-quit-app
                  data-session-option
                  className="settings-navigation-card menu-card-danger"
                  onClick={
                    /**
                     * Handle onClick on this App control using the current render's values; delegate state/IPC work to its owning component.
                     */
                    () => window.electronAPI.quitApp()
                  }
                >
                  <MenuCardContent icon="power" title={t('quit')} description={t('quitCardHelp')} />
                </button>
              </>
            )}
            {panel.type === 'deleteBios' && (
              <>
                <p className="mb-5">
                  {panel.platform} · {t('deleteBiosHelp')}
                </p>
                <button
                  data-initial-focus
                  data-confirm-delete-bios
                  className="console-button"
                  disabled={busy}
                  onClick={
                    /**
                     * Handle onClick on this App control using the current render's values; delegate state/IPC work to its owning component.
                     */
                    () =>
                      run(
                        /**
                         * Perform one App operation or its success continuation under the parent's busy/error handling.
                         */
                        () => window.electronAPI.deleteBios(panel.platform),
                        /**
                         * Perform one App operation or its success continuation under the parent's busy/error handling.
                         */
                        () => setPanel({ type: 'systems' })
                      )
                  }
                >
                  <InputHint keyboard="Enter" gamepad="A">
                    {t('confirm')}
                  </InputHint>
                </button>
              </>
            )}
            {['settings', 'systems'].includes(panel.type) && (
              <SystemSettings
                wallpaperOnly={wallpapers.onlyCustom}
                focusUpdate={panel.focus === 'software-update'}
                updateTasks={downloads}
                systemPage={panel.type === 'systems'}
                onOpenWallpapers={() => openPanel({ type: 'wallpapers' })}
                onBrowseCores={
                  /**
                   * Handle onBrowseCores on this App control using the current render's values; delegate state/IPC work to its owning component.
                   *
                   * @param {*} platform - Value supplied by the enclosing operation; interpreted in this callback's local scope.
                   */
                  (platform) => openPanel({ type: 'coreBrowser', platform })
                }
                onOpenSystems={
                  /**
                   * Handle onOpenSystems on this App control using the current render's values; delegate state/IPC work to its owning component.
                   */
                  () => openPanel({ type: 'systems' })
                }
                onDeleteBios={
                  /**
                   * Handle onDeleteBios on this App control using the current render's values; delegate state/IPC work to its owning component.
                   *
                   * @param {*} platform - Value supplied by the enclosing operation; interpreted in this callback's local scope.
                   */
                  (platform) => openPanel({ type: 'deleteBios', platform })
                }
                preferences={preferences}
                togglePreference={togglePreference}
                saveHotkeys={saveHotkeys}
                playSound={playSound}
              />
            )}
            {panel.type === 'wallpapers' && (
              <WallpaperGallery model={wallpapers} playSound={playSound} />
            )}
          </ConsoleModal>
        )}
        {launchState && launchState.phase !== 'running' && (
          <div
            role="status"
            aria-live="polite"
            className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-5 bg-slate-950/80 backdrop-blur-xl"
          >
            <div className="size-16 rounded-full border-2 border-white/10 border-t-blue-400 animate-spin" />
            <h2 className="text-2xl font-bold">{t('starting')}</h2>
            <p className="text-white/50">{launchState.title}</p>
          </div>
        )}
      </div>
      {filePicker.browser}
    </InputContext.Provider>
  )
}
