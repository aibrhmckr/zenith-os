import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react'
import { createGamepadHotkey, keyboardCode } from '../../shared/hotkeys'
import { CONSOLE_EXTENSIONS } from '../../shared/consoles'
import useGameLibrary from './hooks/useGameLibrary'
import useMediaPreview from './hooks/useMediaPreview'
import useSoundEffects from './hooks/useSoundEffects'
import useController from './hooks/useController'
import useClock from './hooks/useClock'
import usePreferences from './hooks/usePreferences'
import useGridColumns from './hooks/useGridColumns'
import { useI18n } from './hooks/i18n'
import { InputContext } from './hooks/inputContext'
import GuideDrawer from './components/GuideDrawer'
import OnScreenKeyboard from './components/OnScreenKeyboard'
import ConsoleModal from './components/ConsoleModal'
import CoreBrowser from './components/CoreBrowser'
import SystemSettings from './components/SystemSettings'
import InputHint, { KeyBadge } from './components/InputHint'

const moveIndex = (index, direction, total, columns) => {
  if (!total) return 0
  if (direction === 'right') return Math.min(total - 1, index + 1)
  if (direction === 'left') return Math.max(0, index - 1)
  if (direction === 'up') return index >= columns ? index - columns : index
  return (Math.floor(index / columns) + 1) * columns < total
    ? Math.min(total - 1, index + columns)
    : index
}
export default function App() {
  const { t } = useI18n()
  const { games, loading, error, scanning, progress, warning, refresh, removeFromState } =
    useGameLibrary()
  const { preferences, togglePreference, saveHotkeys } = usePreferences()
  const { play: playSound } = useSoundEffects(preferences.menuSounds)
  const gridRef = useRef(null)
  const columns = useGridColumns(gridRef)
  const clock = useClock()
  const hotkeyInput = useRef(createGamepadHotkey())
  const [currentIndex, setCurrentIndex] = useState(0),
    [consoleChoice, setSelectedConsole] = useState('ALL')
  const [searchQuery, setSearchQuery] = useState(''),
    [searchDraft, setSearchDraft] = useState(''),
    [oskOpen, setOskOpen] = useState(false)
  const [guideGame, setGuideGame] = useState(null),
    [panel, setPanel] = useState(null),
    [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState(''),
    [operationError, setOperationError] = useState('')
  const [launchState, setLaunchState] = useState(null),
    [previewEnabled, setPreviewEnabled] = useState(true)
  const selectedCardRef = useRef(null),
    searchInputRef = useRef(null),
    activeGameRef = useRef(null),
    launchBusyRef = useRef(false),
    restoreFocus = useRef(false),
    returnGame = useRef(null),
    panelReturnCard = useRef(null),
    oskRef = useRef(false)
  const consoles = useMemo(
    () => [
      'ALL',
      ...Object.keys(CONSOLE_EXTENSIONS).filter((system) =>
        games.some((game) => game.systemShort === system)
      )
    ],
    [games]
  )
  const selectedConsole = consoles.includes(consoleChoice) ? consoleChoice : 'ALL'
  const filteredGames = games.filter(
    (game) =>
      (selectedConsole === 'ALL' || game.systemShort === selectedConsole) &&
      game.title.toLowerCase().includes(searchQuery.toLowerCase())
  )
  const focusedIndex = Math.min(currentIndex, Math.max(0, filteredGames.length - 1))
  const activeGame = filteredGames[focusedIndex] || null
  const {
    videoRef,
    audioRef,
    cinematic,
    stop: stopPreview,
    restart: restartPreview,
    fadeOut
  } = useMediaPreview(
    activeGame,
    previewEnabled &&
      (!launchState || launchState.phase === 'fading') &&
      !guideGame &&
      !panel &&
      !oskOpen,
    preferences.previewSound
  )
  useEffect(() => {
    activeGameRef.current = activeGame
  }, [activeGame])
  useEffect(() => {
    selectedCardRef.current?.scrollIntoView({
      block: 'nearest',
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'
    })
    if (document.activeElement?.matches('[data-game-card]'))
      selectedCardRef.current?.focus({ preventScroll: true })
  }, [activeGame?.id, columns])
  useLayoutEffect(() => {
    if (!oskOpen && restoreFocus.current) {
      restoreFocus.current = false
      ;(selectedCardRef.current || searchInputRef.current)?.focus({ preventScroll: true })
    }
  }, [oskOpen])
  const openPanel = useCallback(
    (value) => {
      if (value.game) {
        panelReturnCard.current =
          Array.from(document.querySelectorAll('[data-game-card]')).find(
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
  const closePanel = () => {
    if (busy) return
    if (panel?.type === 'coreBrowser') {
      setPanel(
        panel.game
          ? { type: 'core', game: panel.game, platform: panel.platform }
          : { type: 'systems' }
      )
      return
    }
    if (panel?.type === 'systems') {
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
  useLayoutEffect(() => {
    if (!panel && !guideGame && !oskOpen) {
      const card = panelReturnCard.current?.isConnected
        ? panelReturnCard.current
        : selectedCardRef.current
      panelReturnCard.current = null
      card?.focus({ preventScroll: true })
    }
  }, [panel, guideGame, oskOpen])
  const priorGuide = useRef(false)
  useEffect(() => {
    if (!!guideGame !== priorGuide.current) playSound('toggle')
    priorGuide.current = !!guideGame
  }, [guideGame, playSound])
  const closeGuide = useCallback(() => setGuideGame(null), [])
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
  useEffect(() => {
    const a = window.electronAPI.onGameStarted(() =>
      setLaunchState((state) => (state ? { ...state, phase: 'running' } : null))
    )
    const b = window.electronAPI.onGameStopped(() => {
      setLaunchState(null)
      setPanel((p) => (p?.type === 'session' ? null : p))
    })
    const c = window.electronAPI.onSessionMenu((open) => {
      if (open) setPanel({ type: 'session' })
      else setPanel((p) => (p?.type === 'session' ? null : p))
    })
    return () => {
      a()
      b()
      c()
    }
  }, [])
  const launch = useCallback(
    async (game = activeGameRef.current) => {
      if (!game || launchBusyRef.current) return
      launchBusyRef.current = true
      setOperationError('')
      setLaunchState({ phase: 'fading', title: game.title })
      try {
        playSound('launch')
        await fadeOut()
        setLaunchState({ phase: 'starting', title: game.title })
        const result = await window.electronAPI.launchGame(game.path, game.systemShort)
        if (!result.success) {
          if (['missing_core', 'missing_bios'].includes(result.error))
            setPanel({
              type: result.error === 'missing_core' ? 'core' : 'bios',
              platform: result.platform,
              game,
              missing: result.missing
            })
          else setOperationError(result.error || t('error'))
        }
      } catch {
        setOperationError(t('error'))
      } finally {
        launchBusyRef.current = false
        setLaunchState(null)
      }
    },
    [fadeOut, playSound, t]
  )
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
  const addGames = () =>
    run(
      () => window.electronAPI.addGames(),
      async () => {
        setPanel(null)
        setCurrentIndex(0)
        await refresh(false)
      }
    )
  const install = () =>
    run(
      () => window.electronAPI.installCore(panel.platform),
      () => {
        const game = panel.game
        setPanel(null)
        if (game) void launch(game)
      }
    )
  const removeGame = () =>
    run(
      () => window.electronAPI.deleteGame(panel.game.gameId),
      async () => {
        removeFromState(panel.game.gameId)
        setPanel(null)
        setCurrentIndex(0)
        await refresh(false)
      }
    )
  const navigate = useCallback(
    (direction) => {
      if (launchBusyRef.current || oskRef.current || document.querySelector('dialog[open]')) return
      selectedCardRef.current?.focus({ preventScroll: true })
      setPreviewEnabled(true)
      const next = moveIndex(focusedIndex, direction, filteredGames.length, columns)
      if (next !== focusedIndex) playSound('navigate')
      setCurrentIndex(next)
    },
    [focusedIndex, filteredGames.length, columns, playSound]
  )
  const changeConsole = (step) => {
    setSelectedConsole(
      (system) => consoles[(consoles.indexOf(system) + step + consoles.length) % consoles.length]
    )
    setCurrentIndex(0)
    playSound('navigate')
  }
  const openKeyboard = (inputMode) => {
    if (inputMode !== 'gamepad' || oskRef.current || launchBusyRef.current) return
    returnGame.current = activeGame?.id
    setSearchDraft(searchQuery)
    oskRef.current = true
    stopPreview()
    setOskOpen(true)
  }
  const closeKeyboard = () => {
    document.querySelector('[data-osk]')?.close()
    const results = games.filter(
      (game) =>
        (selectedConsole === 'ALL' || game.systemShort === selectedConsole) &&
        game.title.toLowerCase().includes(searchDraft.toLowerCase())
    )
    setSearchQuery(searchDraft)
    setCurrentIndex(
      Math.max(
        0,
        results.findIndex((game) => game.id === returnGame.current)
      )
    )
    oskRef.current = false
    restoreFocus.current = true
    setOskOpen(false)
  }
  const goBack = () => {
    searchInputRef.current?.blur()
    selectedCardRef.current?.focus()
  }
  useEffect(() => {
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
        navigate(direction)
      } else if (event.key === '/') {
        event.preventDefault()
        searchInputRef.current?.focus()
      } else if (event.key.toLowerCase() === 'h') {
        event.preventDefault()
        if (!event.repeat) toggleGuide()
      } else if (event.key.toLowerCase() === 'o' && activeGameRef.current) {
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
          (system) =>
            consoles[(consoles.indexOf(system) + step + consoles.length) % consoles.length]
        )
        setCurrentIndex(0)
      }
    }
    window.addEventListener('keydown', input)
    return () => window.removeEventListener('keydown', input)
  }, [launch, navigate, openPanel, toggleGuide, togglePreference, consoles])
  useEffect(() => {
    const held = new Set()
    let fired = false
    const down = (event) => {
      if (document.querySelector('dialog[open]') || event.target.closest('input,textarea,select'))
        return
      const code = keyboardCode(event)
      held.add(code)
      const pair = preferences.hotkeys.keyboard
      const matches =
        ['Escape', 'F10'].includes(code) ||
        (pair.length === 2 && pair.every((key) => held.has(key)))
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
    const up = (event) => {
      held.delete(keyboardCode(event))
      fired = false
    }
    const reset = () => {
      held.clear()
      fired = false
    }
    window.addEventListener('keydown', down, true)
    window.addEventListener('keyup', up, true)
    window.addEventListener('blur', reset)
    return () => {
      window.removeEventListener('keydown', down, true)
      window.removeEventListener('keyup', up, true)
      window.removeEventListener('blur', reset)
    }
  }, [preferences.hotkeys, openPanel])
  const { mode, controller } = useController((frame) => {
    const surface = Array.from(document.querySelectorAll('dialog[open]')).at(-1)
    const chord = hotkeyInput.current(frame, preferences.hotkeys.gamepad, Boolean(surface))
    const hit = chord.hit
    const directionButton = { up: 12, down: 13, left: 14, right: 15 }[frame.move]
    const releasedDirection = Object.entries({ up: 12, down: 13, left: 14, right: 15 }).find(
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
    if (hit(2)) {
      openKeyboard(frame.inputMode)
      return
    }
    if (hit(3) && activeGame) {
      openPanel({ type: 'options', game: activeGame })
      return
    }
    if (hit(6)) {
      document.querySelector('[data-refresh-library]')?.click()
      return
    }
    if (hit(7)) {
      playSound('toggle')
      togglePreference('previewSound')
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
    if (document.activeElement === searchInputRef.current) {
      if (hit(0)) openKeyboard(frame.inputMode)
      else if (move === 'down') goBack()
      return
    }
    if (hit(0)) {
      void launch()
      return
    }
    if (move) navigate(move)
  })
  return (
    <InputContext.Provider value={mode}>
      <div data-input-mode={mode} className="zenith-shell">
        {activeGame?.backdropUrl && (
          <img
            className={
              'hero-fixed-image transition-opacity duration-700 ' +
              (cinematic && activeGame.videoUrl ? 'opacity-0' : 'opacity-100')
            }
            src={activeGame.backdropUrl}
            alt=""
          />
        )}
        <video
          ref={videoRef}
          key={activeGame?.videoUrl || 'video'}
          src={activeGame?.videoUrl || undefined}
          loop
          playsInline
          preload="none"
          className={
            'hero-fixed-image ' + (cinematic && activeGame?.videoUrl ? 'opacity-100' : 'opacity-0')
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
        <header className="dashboard-header relative z-20 flex shrink-0 items-center justify-between py-5">
          <div className="font-black tracking-[.3em] text-lg">
            ZENITH<span className="ml-2 font-light text-white/45">OS</span>
          </div>
          <div className="flex items-center gap-5">
            {controller && (
              <span
                data-controller-status
                className="glass-bar flex items-center gap-2 rounded-full px-3 py-2 text-xs"
              >
                P1 <span className="size-2 rounded-full bg-emerald-400" />
                {controller.battery !== null && (
                  <span data-controller-battery>{controller.battery}%</span>
                )}
              </span>
            )}
            <button onClick={() => openPanel({ type: 'settings' })}>
              <InputHint keyboard="Menu" gamepad="Menu">
                {t('settings')}
              </InputHint>
            </button>
            <time data-system-clock className="text-lg tabular-nums">
              {clock}
            </time>
          </div>
        </header>
        <main className="dashboard-hero relative z-10 flex-1 pt-5">
          {activeGame ? (
            <>
              <h1 className="text-3xl font-extrabold tracking-wide leading-tight line-clamp-2">
                {activeGame.title}
              </h1>
              <div className="mt-3 flex gap-2 text-sm">
                <span className="hero-tag">{activeGame.systemShort}</span>
              </div>
            </>
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
          data-focused-row={Math.floor(focusedIndex / columns)}
          data-expanded={focusedIndex >= columns}
          className="dashboard-library safe-zone relative z-10 flex flex-col"
        >
          <div className="dashboard-toolbar mb-3 flex shrink-0 flex-wrap items-center justify-start gap-3">
            <button
              data-console-filter
              aria-controls="console-filters"
              onClick={() => openPanel({ type: 'filter' })}
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
            <div className="glass-bar flex items-center gap-3 rounded-xl px-4 py-2">
              <input
                data-search-input
                ref={searchInputRef}
                aria-label={t('search')}
                placeholder={t('search')}
                value={searchQuery}
                onFocus={() => {
                  stopPreview()
                  setPreviewEnabled(false)
                }}
                onChange={(e) => {
                  setSearchQuery(e.target.value)
                  setCurrentIndex(0)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape' || e.key === 'ArrowDown') {
                    e.preventDefault()
                    goBack()
                  }
                }}
                className="bg-transparent outline-none placeholder:text-white/40"
              />
              <button
                data-search-trigger
                aria-label={t('search')}
                onClick={() => searchInputRef.current?.focus()}
              >
                <KeyBadge keyboard="/" gamepad="X" />
              </button>
            </div>
            <button
              data-add-game
              onClick={addGames}
              disabled={loading || busy || scanning}
              className="console-button"
            >
              <KeyBadge keyboard="+" gamepad="R3" />
              {t('add')}
            </button>
            <button
              data-refresh-library
              disabled={scanning || !!launchState}
              onClick={() => void refresh()}
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
              {t('mediaWarning')}
            </p>
          )}
          <div ref={gridRef} className="poster-grid">
            {filteredGames.map((game, index) => (
              <button
                key={game.id}
                data-game-card
                data-game-id={game.id}
                aria-label={game.title}
                aria-pressed={index === focusedIndex}
                tabIndex={index === focusedIndex ? 0 : -1}
                ref={index === focusedIndex ? selectedCardRef : null}
                onFocus={() => {
                  if (oskRef.current) return
                  setCurrentIndex(index)
                  setPreviewEnabled(true)
                  restartPreview()
                }}
                onMouseEnter={() => {
                  if (launchBusyRef.current || oskRef.current) return
                  if (index !== focusedIndex) playSound('navigate')
                  setCurrentIndex(index)
                  setPreviewEnabled(true)
                  restartPreview()
                }}
                onMouseLeave={() => {
                  stopPreview()
                  setPreviewEnabled(false)
                }}
                onBlur={() => {
                  if (!launchBusyRef.current) {
                    stopPreview()
                    setPreviewEnabled(false)
                  }
                }}
                onClick={() => setCurrentIndex(index)}
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
                    onLoad={(event) => {
                      const image = event.currentTarget
                      // Square and landscape packaging keeps its full original artwork.
                      if (Math.abs(image.naturalWidth / image.naturalHeight - 2 / 3) > 0.12)
                        image.style.objectFit = 'contain'
                    }}
                  />
                ) : (
                  <div className="flex h-full items-center justify-center bg-gradient-to-br from-slate-700 to-slate-950 p-4 text-2xl font-black text-white/40">
                    {game.systemShort}
                  </div>
                )}
                <div className="poster-caption absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/95 to-transparent text-left">
                  <span className="text-[10px] font-bold tracking-widest text-blue-200">
                    {game.systemShort}
                  </span>
                  <p className="mt-1 text-xs font-bold line-clamp-2">{game.title}</p>
                </div>
              </button>
            ))}
          </div>
        </section>
        <footer data-library-footer className="dashboard-footer relative z-20 shrink-0">
          <div className="safe-zone flex flex-wrap items-center justify-center gap-x-7 gap-y-3">
            <button
              data-launch-game
              disabled={!activeGame || !!launchState}
              onClick={() => void launch()}
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
            <button
              data-game-options
              disabled={!activeGame}
              onClick={() => openPanel({ type: 'options', game: activeGame })}
            >
              <InputHint keyboard="O" gamepad="Y">
                {t('options')}
              </InputHint>
            </button>
            <button onClick={() => searchInputRef.current?.focus()}>
              <InputHint keyboard="/" gamepad="X">
                {t('searchAction')}
              </InputHint>
            </button>
            <span className="input-hint">
              <KeyBadge keyboard="PgUp / PgDn" gamepad="LB / RB" />
              {t('filter')}
            </span>
            <button onClick={() => openPanel({ type: 'settings' })}>
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
                settings: 'settings',
                systems: 'status',
                deleteBios: 'deleteBios',
                options: 'options',
                filter: 'filter',
                delete: 'deleteTitle',
                core: 'core',
                coreBrowser: 'browseCores',
                bios: 'biosMissing',
                session: 'session',
                mainMenu: 'mainMenu'
              }[panel.type]
            )}
            onClose={closePanel}
            busy={busy}
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
              <p role="status" className="mb-4 animate-pulse">
                {t('working')}
              </p>
            )}
            {panel.type === 'options' && (
              <div className="flex flex-col gap-3">
                <p className="mb-3 text-xl font-bold">{panel.game.title}</p>
                <button
                  data-game-option
                  data-initial-focus
                  data-open-guide
                  className="console-button"
                  onClick={() => {
                    setPanel(null)
                    setGuideGame(panel.game)
                  }}
                >
                  {t('guide')}
                </button>
                <button
                  data-game-option
                  className="console-button text-rose-200"
                  onClick={() => openPanel({ type: 'delete', game: panel.game })}
                >
                  {t('delete')}
                </button>
              </div>
            )}
            {panel.type === 'filter' && (
              <div data-navigation-grid id="console-filters" className="grid grid-cols-3 gap-3">
                {consoles.map((system) => (
                  <button
                    key={system}
                    className="console-button"
                    aria-pressed={selectedConsole === system}
                    onClick={() => {
                      setSelectedConsole(system)
                      setCurrentIndex(0)
                      setPanel(null)
                    }}
                  >
                    {system === 'ALL' ? t('all') : system}
                  </button>
                ))}
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
                onSelect={(core) =>
                  run(
                    () =>
                      window.electronAPI.selectCore({
                        gameId: panel.game?.gameId,
                        platform: panel.platform,
                        core
                      }),
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
                <p className="mb-6">
                  {panel.platform} · {t('coreMissing')}
                </p>
                <button disabled={busy} onClick={install} className="console-button">
                  {t('install')}
                </button>
                <button
                  data-browse-cores
                  disabled={busy}
                  onClick={() => openPanel({ ...panel, type: 'coreBrowser' })}
                  className="console-button ml-3"
                >
                  {t('browseCores')}
                </button>
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
                    onClick={() =>
                      run(
                        () => window.electronAPI.uploadBios(panel.platform),
                        (result) => {
                          setNotice(result.status?.ready ? t('ready') : t('biosNotReady'))
                          setPanel((p) => ({ ...p, ready: !!result.status?.ready }))
                        }
                      )
                    }
                    className="console-button"
                  >
                    {t('uploadBios')}
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => run(() => window.electronAPI.openBiosFolder(panel.platform))}
                    className="console-button"
                  >
                    {t('folder')}
                  </button>
                  {panel.ready && (
                    <button
                      data-launch-after-bios
                      disabled={busy}
                      onClick={() => {
                        const game = panel.game
                        setPanel(null)
                        void launch(game)
                      }}
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
                <button className="console-button" onClick={closePanel}>
                  {t('back')}
                </button>
                <button className="console-button" onClick={() => openPanel({ type: 'settings' })}>
                  {t('settings')}
                </button>
                <button
                  data-quit-app
                  className="console-button text-rose-300"
                  onClick={() => window.electronAPI.quitApp()}
                >
                  {t('quit')}
                </button>
              </div>
            )}
            {panel.type === 'session' && (
              <>
                <p className="mb-5 text-white/60">{t('sessionHelp')}</p>
                <div className="flex flex-col gap-3">
                  <button className="console-button" onClick={closePanel}>
                    {t('resume')}
                  </button>
                  <button
                    className="console-button text-rose-200"
                    onClick={() => void window.electronAPI.stopSession()}
                  >
                    {t('stop')}
                  </button>
                </div>
                <button
                  data-quit-app
                  className="console-button mt-4 text-rose-300"
                  onClick={() => window.electronAPI.quitApp()}
                >
                  {t('quit')}
                </button>
                <p className="mt-5 text-xs text-white/40">{t('homeHelp')}</p>
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
                  onClick={() =>
                    run(
                      () => window.electronAPI.deleteBios(panel.platform),
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
                systemPage={panel.type === 'systems'}
                onBrowseCores={(platform) => openPanel({ type: 'coreBrowser', platform })}
                onOpenSystems={() => openPanel({ type: 'systems' })}
                onDeleteBios={(platform) => openPanel({ type: 'deleteBios', platform })}
                preferences={preferences}
                togglePreference={togglePreference}
                saveHotkeys={saveHotkeys}
                playSound={playSound}
              />
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
    </InputContext.Provider>
  )
}
