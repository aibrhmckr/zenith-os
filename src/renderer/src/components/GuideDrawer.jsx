import { useEffect, useRef, useState } from 'react'
import InputHint, { KeyBadge } from './InputHint'
import { useI18n } from '../hooks/i18n'
/* eslint-disable react/prop-types -- Internal React 19 component, fed by the selected library game. */

export default function GuideDrawer({ game, onClose }) {
  const { t } = useI18n()
  const TIPS = ['tip1', 'tip2', 'tip3'].map(t)
  const dialogRef = useRef(null)
  const [tab, setTab] = useState('lore')
  const [lore, setLore] = useState(null)
  const [manual, setManual] = useState(null)
  const [features, setFeatures] = useState({ loreEnabled: true, manualsEnabled: true })
  const [loadingLore, setLoadingLore] = useState(true)
  const [loadingManual, setLoadingManual] = useState(true)
  const [page, setPage] = useState(0)
  const [pageResult, setPageResult] = useState(null)
  const cachedPages = useRef(new Map())
  const scrollAt = useRef(0)
  const pageCount = manual?.pageCount || 0

  useEffect(() => {
    const previous = document.activeElement
    dialogRef.current?.showModal()
    dialogRef.current?.querySelector('[data-guide-tab="lore"]')?.focus()
    let cancelled = false
    window.electronAPI
      .getGuideFeatures()
      .then((value) => {
        if (!cancelled) setFeatures(value)
      })
      .catch(() => {})
    window.electronAPI
      .getGameLore(game.gameId)
      .then((value) => {
        if (!cancelled) setLore(value)
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoadingLore(false)
      })
    window.electronAPI
      .getGameManual(game.gameId)
      .then((value) => {
        if (!cancelled) setManual(value)
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoadingManual(false)
      })
    return () => {
      cancelled = true
      previous?.focus({ preventScroll: true })
    }
  }, [game.gameId])

  useEffect(() => {
    if (!pageCount || !features.manualsEnabled) return
    // Warm the cover page while reading lore; subsequent pages load only when requested.
    let cancelled = false
    const cached = cachedPages.current.get(page)
    const request = cached
      ? Promise.resolve(cached)
      : window.electronAPI.getManualPage(game.gameId, page)
    request
      .then((url) => {
        if (url) cachedPages.current.set(page, url)
        if (!cancelled) setPageResult({ page, url })
      })
      .catch(() => {
        if (!cancelled) setPageResult({ page, url: null })
      })
    return () => {
      cancelled = true
    }
  }, [game.gameId, page, pageCount, features.manualsEnabled])

  const turnPage = (step) =>
    setPage((current) => Math.max(0, Math.min(pageCount - 1, current + step)))
  const selectTab = (value) => {
    setTab(value)
    dialogRef.current?.querySelector(`[data-guide-tab="${value}"]`)?.focus()
  }
  const shownPage = pageResult?.page === page ? pageResult : null

  useEffect(() => {
    const dialog = dialogRef.current
    const handleController = ({ detail: { hit, buttons, axes, move, now } }) => {
      if (hit(1) || hit(3)) {
        onClose()
        return
      }
      if (hit(4) || hit(5)) {
        selectTab(hit(5) ? 'manual' : 'lore')
        return
      }
      const scroll = buttons[13] ? 1 : buttons[12] ? -1 : axes[3] || axes[1] || 0
      if (scroll && now >= scrollAt.current) {
        dialog
          .querySelector('[role="tabpanel"]:not([hidden])')
          ?.scrollBy({ top: scroll * 90, behavior: 'smooth' })
        scrollAt.current = now + 100
      }
      if (move === 'left' || move === 'right') {
        if (tab === 'manual') turnPage(move === 'right' ? 1 : -1)
      }
      if (hit(0)) dialog.querySelector('button:focus:not(:disabled), a:focus[href]')?.click()
    }
    dialog.addEventListener('controller-input', handleController)
    return () => dialog.removeEventListener('controller-input', handleController)
  })

  return (
    <dialog
      ref={dialogRef}
      data-guide-drawer
      aria-labelledby="guide-title"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' || event.key.toLowerCase() === 'h') {
          event.preventDefault()
          event.stopPropagation()
          if (!event.repeat) onClose()
          return
        }
        if (['ArrowLeft', 'ArrowRight'].includes(event.key)) {
          event.preventDefault()
          event.stopPropagation()
          if (tab === 'manual') turnPage(event.key === 'ArrowRight' ? 1 : -1)
        }
        if (event.key === 'PageUp' || event.key === 'PageDown') {
          event.preventDefault()
          dialogRef.current
            ?.querySelector('[role="tabpanel"]:not([hidden])')
            ?.scrollBy({ top: event.key === 'PageDown' ? 300 : -300, behavior: 'smooth' })
        }
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          event.preventDefault()
          dialogRef.current
            ?.querySelector('[role="tabpanel"]:not([hidden])')
            ?.scrollBy({ top: event.key === 'ArrowDown' ? 90 : -90, behavior: 'smooth' })
        }
      }}
      className="guide-drawer fixed inset-y-0 left-auto right-0 m-0 h-dvh max-h-none w-[min(94vw,620px)] max-w-none border-l border-white/15 bg-slate-950/80 p-0 text-white shadow-2xl backdrop-blur-3xl backdrop:bg-black/55 backdrop:backdrop-blur-sm"
    >
      <div className="flex h-full flex-col" onClick={(event) => event.stopPropagation()}>
        <header className="shrink-0 border-b border-white/10 p-7 pb-5">
          <div className="flex items-center justify-between gap-4">
            <button
              type="button"
              data-close-guide
              onClick={onClose}
              aria-label={t('close')}
              className="rounded-full border border-white/15 px-3 py-2 text-xs hover:bg-white/10"
            >
              <InputHint keyboard="Esc" gamepad="B">
                {t('close')}
              </InputHint>
            </button>
          </div>
          <h2 id="guide-title" className="mt-4 text-2xl font-bold tracking-tight">
            {game.title}
          </h2>
          <div
            role="tablist"
            aria-label={t('guide')}
            className="mt-6 grid grid-cols-2 gap-2 rounded-2xl bg-black/25 p-1.5"
          >
            {[
              ['lore', t('lore')],
              ['manual', t('manual')]
            ].map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="tab"
                id={`guide-tab-${value}`}
                data-guide-tab={value}
                aria-selected={tab === value}
                aria-controls={`guide-panel-${value}`}
                tabIndex={0}
                onClick={() => selectTab(value)}
                className={`rounded-xl px-3 py-3 text-sm font-semibold transition ${tab === value ? 'bg-sky-200 text-slate-950 shadow-lg' : 'text-white/55 hover:bg-white/10'}`}
              >
                <span className="inline-flex items-center gap-2">
                  {value === 'lore' && <KeyBadge keyboard="Tab" gamepad="LB" />}
                  {label}
                  {value === 'manual' && <KeyBadge keyboard="Tab" gamepad="RB" />}
                </span>
              </button>
            ))}
          </div>
        </header>
        <section
          role="tabpanel"
          id="guide-panel-lore"
          aria-labelledby="guide-tab-lore"
          hidden={tab !== 'lore'}
          className="min-h-0 flex-1 overflow-y-auto p-7"
        >
          {!features.loreEnabled ? (
            <p className="guide-empty">{t('disabled')}</p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div className="guide-fact">
                  <span>{t('developer')}</span>
                  <strong>{lore?.developer || t('unknown')}</strong>
                </div>
                <div className="guide-fact">
                  <span>{t('year')}</span>
                  <strong>{lore?.year || t('unknown')}</strong>
                </div>
              </div>
              <h3 className="mb-3 mt-7 text-sm font-semibold text-sky-100">{t('lore')}</h3>
              {loadingLore ? (
                <p role="status" className="guide-empty motion-safe:animate-pulse">
                  {t('loreLoading')}
                </p>
              ) : lore ? (
                <>
                  <p className="select-text text-sm leading-7 text-white/75">{lore.summary}</p>
                  <a
                    href={lore.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-3 inline-block text-xs text-sky-300 underline"
                  >
                    {t('source')}: Wikipedia · English · CC BY-SA
                  </a>
                </>
              ) : (
                <p className="guide-empty">{t('loreEmpty')}</p>
              )}
              <div className="mt-8 rounded-2xl border border-emerald-200/15 bg-emerald-300/5 p-5">
                <h3 className="text-sm font-semibold text-emerald-100">{t('tips')}</h3>
                <p className="mt-1 text-[11px] text-white/40">{t('tips')}</p>
                <ol className="mt-4 space-y-4 text-sm leading-6 text-white/65">
                  {TIPS.map((tip, index) => (
                    <li key={tip} className="flex gap-3">
                      <span className="text-emerald-300/60">0{index + 1}</span>
                      <span>{tip}</span>
                    </li>
                  ))}
                </ol>
              </div>
            </>
          )}
        </section>
        <section
          role="tabpanel"
          id="guide-panel-manual"
          aria-labelledby="guide-tab-manual"
          hidden={tab !== 'manual'}
          className="min-h-0 flex-1 overflow-y-auto p-6"
        >
          {!features.manualsEnabled ? (
            <p className="guide-empty">{t('disabled')}</p>
          ) : loadingManual ? (
            <p role="status" className="guide-empty motion-safe:animate-pulse">
              {t('manualLoading')}
            </p>
          ) : !manual ? (
            <div data-manual-empty className="guide-empty">
              <span className="mb-3 block text-3xl" aria-hidden="true">
                ▤
              </span>
              {t('manualEmpty')}
            </div>
          ) : (
            <>
              <div className="mb-4 flex items-center justify-between gap-3">
                <button
                  type="button"
                  data-guide-prev
                  aria-label="←"
                  disabled={page <= 0}
                  onClick={() => turnPage(-1)}
                  className="guide-page-button"
                >
                  <span aria-hidden="true">←</span>
                </button>
                <p aria-live="polite" data-guide-page-count className="text-xs text-white/60">
                  {t('page')} {page + 1} / {pageCount}
                </p>
                <button
                  type="button"
                  data-guide-next
                  aria-label="→"
                  disabled={page >= pageCount - 1}
                  onClick={() => turnPage(1)}
                  className="guide-page-button"
                >
                  <span aria-hidden="true">→</span>
                </button>
              </div>
              <div className="flex min-h-64 items-center justify-center rounded-xl border border-white/10 bg-black/30 p-2 shadow-inner">
                {!shownPage ? (
                  <p role="status" className="guide-empty motion-safe:animate-pulse">
                    {t('pageLoading')}
                  </p>
                ) : shownPage.url ? (
                  <img
                    key={`${game.gameId}-${page}`}
                    data-manual-image
                    src={shownPage.url}
                    alt={`${game.title} ${t('manual')}, ${t('page')} ${page + 1}`}
                    className="max-h-[62vh] w-full rounded object-contain shadow-2xl"
                    onError={() => {
                      cachedPages.current.delete(page)
                      setPageResult({ page, url: null })
                    }}
                  />
                ) : (
                  <p className="guide-empty">{t('pageError')}</p>
                )}
              </div>
              <a
                href={manual.sourceUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-4 inline-block text-xs text-sky-300 underline"
              >
                {t('manual')} · Internet Archive
              </a>
            </>
          )}
        </section>
        <footer className="shrink-0 border-t border-white/10 px-7 py-4 text-[11px] text-white/65 flex flex-wrap gap-4">
          <span className="input-hint">
            <KeyBadge keyboard="Tab" gamepad="LB" />
            <KeyBadge keyboard="Enter" gamepad="RB" />
            {t('tabs')}
          </span>
          <InputHint keyboard="↑↓" gamepad="R-Stick">
            {t('scroll')}
          </InputHint>
          <InputHint keyboard="Esc" gamepad="B">
            {t('close')}
          </InputHint>
          {tab === 'manual' && (
            <InputHint keyboard="←→" gamepad="D-Pad ↔">
              {t('pages')}
            </InputHint>
          )}
        </footer>
      </div>
    </dialog>
  )
}
