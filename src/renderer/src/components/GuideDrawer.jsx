import { useEffect, useRef, useState } from 'react'
import InputHint, { KeyBadge } from './InputHint'
import { useI18n } from '../hooks/i18n'
/* eslint-disable react/prop-types -- Internal React 19 component, fed by the selected library game. */

/**
 * Show optional lore and cached manual pages for one selected game. Own modal focus, ignore
 * stale asynchronous results, and isolate tabs/page navigation from the library.
 *
 * @param {Object} options - Named inputs for this operation.
 * @param {Object} options.game - Library game record, including identity, platform, and available local media.
 * @param {Function} options.onClose - Ask the owner to dismiss this surface and restore its prior focus.
 */
export default function GuideDrawer({ game, onClose }) {
  const { t } = useI18n()
  /**
   * Localized static introductory tips; no generated lore or remote AI request is used.
   */
  const TIPS = ['tip1', 'tip2', 'tip3'].map(t)
  /**
   * Native drawer dialog owns focus and controller event routing.
   */
  const dialogRef = useRef(null)
  /**
   * Active fixed endpoint: lore or manual; shoulder navigation never wraps.
   */
  const [tab, setTab] = useState('lore')
  /**
   * Optional Wikipedia summary result; null renders a local empty state.
   */
  const [lore, setLore] = useState(null)
  /**
   * Optional public manual descriptor: title, pageCount, and sourceUrl.
   */
  const [manual, setManual] = useState(null)
  /**
   * Service-provided switches control both visible sections and whether pages are requested.
   */
  const [features, setFeatures] = useState({ loreEnabled: true, manualsEnabled: true })
  /**
   * Lore pending state is independent from manual lookup.
   */
  const [loadingLore, setLoadingLore] = useState(true)
  /**
   * Manual pending state is independent from lore lookup.
   */
  const [loadingManual, setLoadingManual] = useState(true)
  /**
   * Zero-based selected manual page; it must stay within the returned page count.
   */
  const [page, setPage] = useState(0)
  /**
   * Tagged page result prevents a late response from displaying under a different selected page.
   */
  const [pageResult, setPageResult] = useState(null)
  /**
   * Local page-index to protocol-URL map avoids duplicate IPC for previously viewed pages.
   */
  const cachedPages = useRef(new Map())
  /**
   * Next permitted controller scroll time in milliseconds; throttles continuous stick/D-pad input.
   */
  const scrollAt = useRef(0)
  const pageCount = manual?.pageCount || 0

  /**
   * Open with lore-tab focus, fetch features/lore/manual independently, and discard late responses
   * after dismissal.
   */
  useEffect(() => {
    const previous = document.activeElement
    dialogRef.current?.showModal()
    dialogRef.current?.querySelector('[data-guide-tab="lore"]')?.focus()
    let cancelled = false
    window.electronAPI
      .getGuideFeatures()
      .then(
        /**
         * Continue GuideDrawer after the preceding asynchronous stage resolves; the returned value or Promise feeds the same chain.
         *
         * @param {*} value - Value supplied by the enclosing operation; interpreted in this callback's local scope.
         */
        (value) => {
          if (!cancelled) setFeatures(value)
        }
      )
      .catch(
        /**
         * Handle the rejected stage of GuideDrawer here so its failure follows this operation's fallback/error policy.
         */
        () => {}
      )
    window.electronAPI
      .getGameLore(game.gameId)
      .then(
        /**
         * Continue GuideDrawer after the preceding asynchronous stage resolves; the returned value or Promise feeds the same chain.
         *
         * @param {*} value - Value supplied by the enclosing operation; interpreted in this callback's local scope.
         */
        (value) => {
          if (!cancelled) setLore(value)
        }
      )
      .catch(
        /**
         * Handle the rejected stage of GuideDrawer here so its failure follows this operation's fallback/error policy.
         */
        () => {}
      )
      .finally(
        /**
         * Release GuideDrawer's pending-work bookkeeping after either success or failure.
         */
        () => {
          if (!cancelled) setLoadingLore(false)
        }
      )
    window.electronAPI
      .getGameManual(game.gameId)
      .then(
        /**
         * Continue GuideDrawer after the preceding asynchronous stage resolves; the returned value or Promise feeds the same chain.
         *
         * @param {*} value - Value supplied by the enclosing operation; interpreted in this callback's local scope.
         */
        (value) => {
          if (!cancelled) setManual(value)
        }
      )
      .catch(
        /**
         * Handle the rejected stage of GuideDrawer here so its failure follows this operation's fallback/error policy.
         */
        () => {}
      )
      .finally(
        /**
         * Release GuideDrawer's pending-work bookkeeping after either success or failure.
         */
        () => {
          if (!cancelled) setLoadingManual(false)
        }
      )
    /**
     * Release the listeners, timers, or focus ownership acquired by GuideDrawer's effect before it reruns or unmounts.
     */
    return () => {
      cancelled = true
      previous?.focus({ preventScroll: true })
    }
  }, [game.gameId])

  /**
   * Prefetch the cover or selected page; cache successful URLs while ignoring stale page display
   * results.
   */
  useEffect(() => {
    if (!pageCount || !features.manualsEnabled) return
    // Warm the cover page while reading lore; subsequent pages load only when requested.
    let cancelled = false
    const cached = cachedPages.current.get(page)
    const request = cached
      ? Promise.resolve(cached)
      : window.electronAPI.getManualPage(game.gameId, page)
    request
      .then(
        /**
         * Continue GuideDrawer after the preceding asynchronous stage resolves; the returned value or Promise feeds the same chain.
         *
         * @param {*} url - Value supplied by the enclosing operation; interpreted in this callback's local scope.
         */
        (url) => {
          if (url) cachedPages.current.set(page, url)
          if (!cancelled) setPageResult({ page, url })
        }
      )
      .catch(
        /**
         * Handle the rejected stage of GuideDrawer here so its failure follows this operation's fallback/error policy.
         */
        () => {
          if (!cancelled) setPageResult({ page, url: null })
        }
      )
    /**
     * Release the listeners, timers, or focus ownership acquired by GuideDrawer's effect before it reruns or unmounts.
     */
    return () => {
      cancelled = true
    }
  }, [game.gameId, page, pageCount, features.manualsEnabled])

  /**
   * Clamp a relative page step within the current manual; never wrap from the final page to the
   * cover.
   *
   * @param {number} step - Signed relative movement, normally -1 or +1.
   */
  const turnPage = (step) =>
    setPage(
      /**
       * Compute turnPage's next React state from the latest queued value, avoiding stale render snapshots.
       *
       * @param {*} current - Latest queued state or collection entry.
       */
      (current) => Math.max(0, Math.min(pageCount - 1, current + step))
    )
  /**
   * Select the requested tab and move focus to its header; LB/RB choose fixed endpoints rather
   * than cycling.
   *
   * @param {*} value - Input value being normalized, displayed, or committed by this helper.
   */
  const selectTab = (value) => {
    setTab(value)
    dialogRef.current?.querySelector(`[data-guide-tab="${value}"]`)?.focus()
  }
  const shownPage = pageResult?.page === page ? pageResult : null

  /**
   * Register drawer-only controller navigation with current tab/page state and remove the previous
   * handler.
   */
  useEffect(() => {
    const dialog = dialogRef.current
    /**
     * Handle B/Y dismissal, LB/RB tabs, throttled vertical scrolling, and horizontal manual pages. A
     * activates only a focused drawer control.
     *
     * @param {Object} options - Named inputs for this operation.
     * @param {Object} options.detail - Named inputs for this operation.
     * @param {Function} options.detail.hit - True only for a newly pressed button index.
     * @param {boolean[]} options.detail.buttons - Current standard gamepad button states.
     * @param {number[]} options.detail.axes - Deadzone-filtered gamepad axes.
     * @param {string} options.detail.move - Throttled navigation direction, or null on frames without movement.
     * @param {number} options.detail.now - Animation-frame timestamp in milliseconds.
     */
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
    /**
     * Release the listeners, timers, or focus ownership acquired by GuideDrawer's effect before it reruns or unmounts.
     */
    return () => dialog.removeEventListener('controller-input', handleController)
  })

  return (
    <dialog
      ref={dialogRef}
      data-guide-drawer
      aria-labelledby="guide-title"
      onCancel={
        /**
         * Handle onCancel on this GuideDrawer control using the current render's values; delegate state/IPC work to its owning component.
         *
         * @param {*} event - DOM/Electron event supplied by the subscription.
         */
        (event) => {
          event.preventDefault()
          onClose()
        }
      }
      onClick={
        /**
         * Handle onClick on this GuideDrawer control using the current render's values; delegate state/IPC work to its owning component.
         *
         * @param {*} event - DOM/Electron event supplied by the subscription.
         */
        (event) => {
          if (event.target === event.currentTarget) onClose()
        }
      }
      onKeyDown={
        /**
         * Handle onKeyDown on this GuideDrawer control using the current render's values; delegate state/IPC work to its owning component.
         *
         * @param {*} event - DOM/Electron event supplied by the subscription.
         */
        (event) => {
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
        }
      }
      className="guide-drawer fixed inset-y-0 left-auto right-0 m-0 h-dvh max-h-none w-[min(94vw,620px)] max-w-none border-l border-white/15 bg-slate-950/80 p-0 text-white shadow-2xl backdrop-blur-3xl backdrop:bg-black/55 backdrop:backdrop-blur-sm"
    >
      <div
        className="flex h-full flex-col"
        onClick={
          /**
           * Handle onClick on this GuideDrawer control using the current render's values; delegate state/IPC work to its owning component.
           *
           * @param {*} event - DOM/Electron event supplied by the subscription.
           */
          (event) => event.stopPropagation()
        }
      >
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
            ].map(
              /**
               * Project each [ ['lore', t('lore')], ['manual', t('manual')] ] entry for GuideDrawer; preserve input ordering in the derived collection.
               *
               * @param {*} input1 - Value supplied by the enclosing operation; interpreted in this callback's local scope.
               */
              ([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  id={`guide-tab-${value}`}
                  data-guide-tab={value}
                  aria-selected={tab === value}
                  aria-controls={`guide-panel-${value}`}
                  tabIndex={0}
                  onClick={
                    /**
                     * Handle onClick on this GuideDrawer control using the current render's values; delegate state/IPC work to its owning component.
                     */
                    () => selectTab(value)
                  }
                  className={`rounded-xl px-3 py-3 text-sm font-semibold transition ${tab === value ? 'bg-sky-200 text-slate-950 shadow-lg' : 'text-white/55 hover:bg-white/10'}`}
                >
                  <span className="inline-flex items-center gap-2">
                    {value === 'lore' && <KeyBadge keyboard="Tab" gamepad="LB" />}
                    {label}
                    {value === 'manual' && <KeyBadge keyboard="Tab" gamepad="RB" />}
                  </span>
                </button>
              )
            )}
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
                  {TIPS.map(
                    /**
                     * Project each TIPS entry for GuideDrawer; preserve input ordering in the derived collection.
                     *
                     * @param {*} tip - Value supplied by the enclosing operation; interpreted in this callback's local scope.
                     * @param {*} index - Zero-based collection index.
                     */
                    (tip, index) => (
                      <li key={tip} className="flex gap-3">
                        <span className="text-emerald-300/60">0{index + 1}</span>
                        <span>{tip}</span>
                      </li>
                    )
                  )}
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
                  onClick={
                    /**
                     * Handle onClick on this GuideDrawer control using the current render's values; delegate state/IPC work to its owning component.
                     */
                    () => turnPage(-1)
                  }
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
                  onClick={
                    /**
                     * Handle onClick on this GuideDrawer control using the current render's values; delegate state/IPC work to its owning component.
                     */
                    () => turnPage(1)
                  }
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
                    onError={
                      /**
                       * Handle onError on this GuideDrawer control using the current render's values; delegate state/IPC work to its owning component.
                       */
                      () => {
                        cachedPages.current.delete(page)
                        setPageResult({ page, url: null })
                      }
                    }
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
