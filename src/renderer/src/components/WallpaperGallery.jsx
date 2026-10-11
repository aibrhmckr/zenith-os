/* eslint-disable react/prop-types -- Internal gallery model from useWallpapers. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useI18n } from '../hooks/i18n'
import WallpaperVisual from './WallpaperVisual'
import InputHint from './InputHint'

/** Geometric navigation includes the toolbar and both galleries, independent of responsive columns. */
export default function WallpaperGallery({ model, playSound }) {
  const { t } = useI18n(),
    root = useRef(null)
  const [deleting, setDeleting] = useState(null)
  const [selecting, setSelecting] = useState(false)
  const [selectedIds, setSelectedIds] = useState([])
  const customItems = model.items.filter((item) => item.type !== 'theme')
  const selected = selectedIds.filter((id) => customItems.some((item) => item.id === id))
  const origin = useRef(null)
  const lastCustomCard = useRef(null)
  const selectionOrigin = useRef(null)
  const toggleMode = () => {
    if (model.busy || deleting || !customItems.length) return
    const focused = document.activeElement?.closest('[data-wallpaper-custom]')
    const target =
      focused ||
      (lastCustomCard.current?.isConnected ? lastCustomCard.current : null) ||
      root.current?.querySelector('[data-wallpaper-custom]')
    selectionOrigin.current = target
    if (selecting) {
      if (target) toggleSelected(target.dataset.wallpaperCard)
      target?.focus({ preventScroll: true })
      return
    }
    setSelecting(true)
    setSelectedIds(target ? [target.dataset.wallpaperCard] : [])
    playSound('toggle')
  }
  useLayoutEffect(() => {
    if (selecting) {
      selectionOrigin.current?.focus({ preventScroll: true })
    }
  }, [selecting])
  const cancelSelection = () => {
    if (model.busy) return
    setSelecting(false)
    setSelectedIds([])
    root.current?.querySelector('[data-wallpaper-select-mode]')?.focus({ preventScroll: true })
    playSound('toggle')
  }
  const toggleSelected = (id) =>
    setSelectedIds((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id]
    )
  const closeConfirmation = () => {
    if (model.busy) return
    setDeleting(null)
  }
  const askDelete = (id) => {
    if (model.busy) return
    origin.current = document.activeElement
    setDeleting(id)
    playSound('toggle')
  }
  useLayoutEffect(() => {
    if (deleting)
      root.current?.querySelector('[data-wallpaper-confirm]')?.focus({ preventScroll: true })
    else if (origin.current) {
      const target = origin.current.isConnected
        ? origin.current
        : root.current?.querySelector('[data-wallpaper-import]')
      target?.focus({ preventScroll: true })
    }
  }, [deleting])
  const confirmDelete = async () => {
    if (model.busy) return
    const success = await (Array.isArray(deleting)
      ? model.removeSelected(deleting)
      : deleting === 'all'
        ? model.clearAll()
        : model.remove(deleting))
    if (success && Array.isArray(deleting)) {
      setSelecting(false)
      setSelectedIds([])
    }
    origin.current = root.current?.querySelector('[data-wallpaper-import]')
    setDeleting(null)
  }
  const navigate = (direction) => {
    const scope = deleting ? root.current.querySelector('[role=alertdialog]') : root.current
    const buttons = [...scope.querySelectorAll('button:not(:disabled)')]
    const current = buttons.includes(document.activeElement) ? document.activeElement : buttons[0]
    if (!current) return
    const rect = current.getBoundingClientRect()
    const vertical = ['up', 'down'].includes(direction),
      positive = ['down', 'right'].includes(direction)
    const center = (r) => [r.x + r.width / 2, r.y + r.height / 2]
    const [x, y] = center(rect)
    const next =
      (current.closest('.wallpaper-toolbar') && direction === 'down'
        ? buttons.find((button) => button.hasAttribute('data-wallpaper-card'))
        : null) ||
      buttons
        .filter((button) => button !== current)
        .map((button) => {
          const [bx, by] = center(button.getBoundingClientRect())
          const distance = vertical ? by - y : bx - x,
            cross = vertical ? bx - x : by - y
          return { button, distance, score: Math.abs(distance) + Math.abs(cross) * 3 }
        })
        .filter(({ distance }) => (positive ? distance > 1 : distance < -1))
        .sort((a, b) => a.score - b.score)[0]?.button
    if (next) {
      next.focus({ preventScroll: true })
      next.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  }
  useEffect(() => {
    const element = root.current
    const input = ({ detail }) => {
      if (detail.hit(1) && deleting) {
        closeConfirmation()
        return
      }
      if (detail.hit(1) && selecting) {
        cancelSelection()
        return
      }
      if (detail.hit(3) && !deleting) {
        toggleMode()
        return
      }
      if (detail.hit(2) && !deleting) {
        if (selecting) {
          if (selected.length) askDelete([...selected])
          return
        }
        const id = document.activeElement?.closest('[data-wallpaper-entry]')?.dataset.wallpaperEntry
        if (model.items.some((item) => item.id === id && item.type !== 'theme')) askDelete(id)
        return
      }
      if (detail.move) navigate(detail.move)
      if (detail.hit(0) && element.contains(document.activeElement)) document.activeElement.click()
    }
    element.addEventListener('wallpaper-navigation', input)
    return () => element.removeEventListener('wallpaper-navigation', input)
  })
  const action = (callback) => {
    if (!model.busy) {
      playSound('toggle')
      void callback()
    }
  }
  return (
    <div
      ref={root}
      data-wallpaper-gallery
      data-wallpaper-confirming={Boolean(deleting)}
      data-wallpaper-selecting={selecting}
      onFocusCapture={(event) => {
        const card = event.target.closest('[data-wallpaper-custom]')
        if (card) lastCustomCard.current = card
        if (event.target.closest('button')) playSound('navigate')
      }}
      onPointerOver={(event) => {
        const card = event.target.closest('[data-wallpaper-custom]')
        if (card) lastCustomCard.current = card
      }}
      onKeyDown={(event) => {
        if (!deleting && selecting && event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          cancelSelection()
          return
        }
        if (!deleting && !event.repeat && ['s', 'S', 'Delete'].includes(event.key)) {
          event.preventDefault()
          event.stopPropagation()
          if (event.key === 'Delete') {
            if (selecting && selected.length) askDelete([...selected])
          } else toggleMode()
          return
        }
        if (deleting && event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          closeConfirmation()
          return
        }
        if (deleting && event.key === 'Tab') {
          event.preventDefault()
          event.stopPropagation()
          const buttons = [...root.current.querySelectorAll('[role=alertdialog] button')]
          const index = buttons.indexOf(document.activeElement)
          buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus()
        }
        const direction = {
          ArrowUp: 'up',
          ArrowDown: 'down',
          ArrowLeft: 'left',
          ArrowRight: 'right'
        }[event.key]
        if (direction) {
          event.preventDefault()
          event.stopPropagation()
          navigate(direction)
        }
        if (event.key === 'Enter' && event.target.closest('button')) {
          event.preventDefault()
          if (!event.repeat) event.target.closest('button').click()
        }
      }}
    >
      <div className="wallpaper-toolbar">
        <button
          data-initial-focus
          data-wallpaper-only
          role="switch"
          aria-checked={model.onlyCustom}
          aria-disabled={model.busy}
          className="settings-toggle"
          onClick={() => action(model.toggle)}
        >
          <span>{t('wallpaperOnly')}</span>
          <span className="toggle-track" aria-hidden="true">
            <span />
          </span>
        </button>
        <button
          data-wallpaper-import
          className="console-button"
          aria-disabled={model.busy}
          onClick={() => action(model.importFile)}
        >
          {t('wallpaperAdd')}
        </button>
      </div>
      <p className="my-4 text-white/65">{t('wallpaperPriority')}</p>
      <div className="wallpaper-feedback" aria-live="polite">
        {model.error ? (
          <p role="alert" className="text-rose-300">
            {model.error}
          </p>
        ) : (
          <p role="status">{model.busy ? t('working') : '\u00a0'}</p>
        )}
      </div>
      {['theme', 'custom'].map((category) => (
        <section key={category}>
          <div className="wallpaper-section-heading">
            <h3 className="my-5 text-xl font-bold">
              {t(category === 'theme' ? 'wallpaperBuiltIn' : 'wallpaperCustom')}
            </h3>
            {category === 'custom' && model.items.some((item) => item.type !== 'theme') && (
              <div className="wallpaper-selection-actions">
                <button
                  className="console-button"
                  data-wallpaper-select-mode
                  aria-pressed={selecting}
                  aria-disabled={model.busy}
                  onClick={toggleMode}
                >
                  <InputHint keyboard="S" gamepad="Y">
                    {t('wallpaperSelectMode')}
                  </InputHint>
                </button>
                {selecting ? (
                  <>
                    <span role="status" data-wallpaper-selection-count>
                      {selected.length} {t('wallpaperSelectedCount')}
                    </span>
                    <button
                      className="console-button"
                      data-delete-selected-wallpapers
                      aria-disabled={model.busy || !selected.length}
                      onClick={() => {
                        if (selected.length) askDelete([...selected])
                      }}
                    >
                      <InputHint keyboard="Del" gamepad="X">
                        {t('wallpaperDeleteSelected')}
                      </InputHint>
                    </button>
                    <button
                      className="console-button"
                      data-wallpaper-selection-cancel
                      onClick={cancelSelection}
                    >
                      <InputHint keyboard="Esc" gamepad="B">
                        {t('cancel')}
                      </InputHint>
                    </button>
                  </>
                ) : (
                  <button
                    className="console-button"
                    data-delete-all-wallpapers
                    onClick={() => askDelete('all')}
                  >
                    {t('wallpaperDeleteAll')}
                  </button>
                )}
              </div>
            )}
          </div>
          <div className="wallpaper-grid">
            {model.items
              .filter((item) =>
                category === 'theme' ? item.type === 'theme' : item.type !== 'theme'
              )
              .map((item) => (
                <div className="wallpaper-entry" data-wallpaper-entry={item.id} key={item.id}>
                  <button
                    data-wallpaper-card={item.id}
                    data-wallpaper-custom={item.type !== 'theme' ? true : undefined}
                    role={selecting && item.type !== 'theme' ? 'checkbox' : undefined}
                    aria-checked={
                      selecting && item.type !== 'theme' ? selected.includes(item.id) : undefined
                    }
                    aria-pressed={
                      selecting && item.type !== 'theme' ? undefined : item.id === model.selectedId
                    }
                    className="wallpaper-card"
                    aria-disabled={model.busy}
                    onClick={() =>
                      action(() =>
                        selecting && item.type !== 'theme'
                          ? toggleSelected(item.id)
                          : model.select(item.id)
                      )
                    }
                  >
                    <div className="wallpaper-thumbnail">
                      <WallpaperVisual wallpaper={item} />
                    </div>
                    <span className="wallpaper-card-title">{item.name}</span>
                    {selecting && item.type !== 'theme' && (
                      <span className="wallpaper-checkbox" aria-hidden="true">
                        {selected.includes(item.id) ? '✓' : ''}
                      </span>
                    )}
                    {item.id === model.selectedId && (
                      <span className="wallpaper-active">{t('wallpaperActive')}</span>
                    )}
                  </button>
                  {item.type !== 'theme' && !selecting && (
                    <button
                      className="wallpaper-delete"
                      data-delete-wallpaper={item.id}
                      aria-label={t('wallpaperDelete') + ': ' + item.name}
                      title={t('wallpaperDeleteHint')}
                      onClick={() => askDelete(item.id)}
                    >
                      <svg
                        viewBox="0 0 24 24"
                        aria-hidden="true"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                      >
                        <path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7" />
                      </svg>
                    </button>
                  )}
                </div>
              ))}
          </div>
          {category === 'custom' && !model.items.some((item) => item.type !== 'theme') && (
            <p className="text-white/60">{t('wallpaperEmpty')}</p>
          )}
        </section>
      ))}
      {deleting && (
        <div className="wallpaper-confirm-backdrop">
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="wallpaper-delete-title"
            className="wallpaper-confirm"
          >
            <h3 id="wallpaper-delete-title">
              {t(
                Array.isArray(deleting)
                  ? 'wallpaperDeleteSelected'
                  : deleting === 'all'
                    ? 'wallpaperDeleteAll'
                    : 'wallpaperDelete'
              )}
            </h3>
            <p>
              {Array.isArray(deleting)
                ? `${deleting.length} ${t('wallpaperDeleteSelectedConfirm')}`
                : t(deleting === 'all' ? 'wallpaperDeleteAllConfirm' : 'wallpaperDeleteConfirm')}
            </p>
            <div>
              <button
                data-wallpaper-confirm
                className="console-button"
                aria-disabled={model.busy}
                onClick={confirmDelete}
              >
                {t('confirm')}
              </button>
              <button
                data-wallpaper-cancel
                className="console-button"
                aria-disabled={model.busy}
                onClick={closeConfirmation}
              >
                {t('cancel')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
