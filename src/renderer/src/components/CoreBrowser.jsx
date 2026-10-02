/* eslint-disable react/prop-types -- Internal core selection panel. */
import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../hooks/i18n'
import OnScreenKeyboard from './OnScreenKeyboard'

/**
 * Load the trusted core catalog and filter names/filenames after 150 ms. Keep installation in
 * the parent via onSelect and expose gamepad OSK search.
 *
 * @param {Object} options - Named inputs for this operation.
 * @param {Function} options.onSelect - Select a trusted core filename for parent-owned installation.
 * @param {boolean} options.busy - Disable actions while the parent operation is pending.
 */
export default function CoreBrowser({ onSelect, busy }) {
  const { t } = useI18n()
  /**
   * Catalog response, raw search, 150-ms normalized filter, and OSK visibility are independent to
   * support immediate typing without blocking downloads.
   */
  const [catalog, setCatalog] = useState(null),
    [query, setQuery] = useState(''),
    [filter, setFilter] = useState(''),
    [keyboard, setKeyboard] = useState(false)
  /**
   * Search input and routed-controller event root; focus returns here when the OSK closes.
   */
  const input = useRef(null),
    root = useRef(null)
  /**
   * Load the catalog once and ignore late results after the browser unmounts.
   */
  useEffect(() => {
    let active = true
    window.electronAPI
      .listCores()
      .then(
        /**
         * Continue CoreBrowser after the preceding asynchronous stage resolves; the returned value or Promise feeds the same chain.
         *
         * @param {*} result - Value supplied by the enclosing operation; interpreted in this callback's local scope.
         */
        (result) => {
          if (active) setCatalog(result)
        }
      )
      .catch(
        /**
         * Handle the rejected stage of CoreBrowser here so its failure follows this operation's fallback/error policy.
         *
         * @param {*} error - Failure from the preceding operation.
         */
        (error) => {
          if (active) setCatalog({ cores: [], error: error.message })
        }
      )
    /**
     * Release the listeners, timers, or focus ownership acquired by CoreBrowser's effect before it reruns or unmounts.
     */
    return () => {
      active = false
    }
  }, [])
  /**
   * Debounce live name filtering by 150 ms, canceling the prior scheduled query.
   */
  useEffect(() => {
    const timer = setTimeout(
      /**
       * Run delayed timer work only after the owning debounce/wait expires; the surrounding lifecycle owns cancellation.
       */
      () => setFilter(query.trim().toLowerCase()),
      150
    )
    /**
     * Release the listeners, timers, or focus ownership acquired by CoreBrowser's effect before it reruns or unmounts.
     */
    return () => clearTimeout(timer)
  }, [query])
  /**
   * Open core-search OSK from a gamepad interaction only while installation is idle.
   */
  const openKeyboard = () => {
    if (document.documentElement.dataset.inputMode === 'gamepad' && !busy) setKeyboard(true)
  }
  /**
   * Accept gamepad search requests routed by the containing modal and remove that listener on
   * unmount.
   */
  useEffect(() => {
    const node = root.current
    /**
     * Consume parent-routed X or search-field A to open the core browser keyboard.
     *
     * @param {Object} options - Named inputs for this operation.
     * @param {Object} options.detail - CustomEvent payload carrying controller frame data.
     */
    const handler = ({ detail }) => {
      if (detail.hit(2) || (document.activeElement === input.current && detail.hit(0))) {
        setKeyboard(true)
      }
    }
    node.addEventListener('controller-core-search', handler)
    /**
     * Release the listeners, timers, or focus ownership acquired by CoreBrowser's effect before it reruns or unmounts.
     */
    return () => node.removeEventListener('controller-core-search', handler)
  }, [])
  /**
   * Dismiss the keyboard and return focus to the search field on the next frame.
   */
  const closeKeyboard = () => {
    setKeyboard(false)
    requestAnimationFrame(
      /**
       * Synchronize closeKeyboard's focus/animation work with the next frame rather than an intermediate DOM state.
       */
      () => input.current?.focus()
    )
  }
  const results = (catalog?.cores || []).filter(
    /**
     * Retain only catalog?.cores || [] entries satisfying results's local predicate; excluded values do not reach the next stage.
     *
     * @param {*} core - Value supplied by the enclosing operation; interpreted in this callback's local scope.
     */
    (core) => (core.name + ' ' + core.fileName).toLowerCase().includes(filter)
  )
  return (
    <div ref={root} data-core-browser>
      <input
        ref={input}
        data-initial-focus
        data-core-search
        aria-label={t('searchCores')}
        className="osk-input mb-4"
        value={query}
        disabled={busy}
        placeholder={t('searchCores')}
        onChange={
          /**
           * Handle onChange on this CoreBrowser control using the current render's values; delegate state/IPC work to its owning component.
           *
           * @param {*} event - DOM/Electron event supplied by the subscription.
           */
          (event) => setQuery(event.target.value)
        }
        onClick={openKeyboard}
        onKeyDown={
          /**
           * Handle onKeyDown on this CoreBrowser control using the current render's values; delegate state/IPC work to its owning component.
           *
           * @param {*} event - DOM/Electron event supplied by the subscription.
           */
          (event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              root.current.querySelector('[data-core-choice]')?.focus()
            }
          }
        }
      />
      {!catalog && <p role="status">{t('loading')}</p>}
      {catalog?.offline && <p className="mb-3 text-amber-200">{t('coreOffline')}</p>}
      {catalog && !results.length && <p role="status">{catalog.error || t('noResults')}</p>}
      <div data-core-results className="flex max-h-[40vh] flex-col gap-2 overflow-y-auto p-2">
        {results.map(
          /**
           * Project each results entry for CoreBrowser; preserve input ordering in the derived collection.
           *
           * @param {*} core - Value supplied by the enclosing operation; interpreted in this callback's local scope.
           */
          (core) => (
            <button
              key={core.fileName}
              data-core-choice={core.fileName}
              disabled={busy}
              className="console-button justify-between text-left"
              onClick={
                /**
                 * Handle onClick on this CoreBrowser control using the current render's values; delegate state/IPC work to its owning component.
                 */
                () => onSelect(core.fileName)
              }
            >
              <span>
                {core.name}
                <small className="block text-white/50">{core.fileName}</small>
              </span>
              <span>{core.installed ? t('ready') : t('install')}</span>
            </button>
          )
        )}
      </div>
      {keyboard && <OnScreenKeyboard value={query} onChange={setQuery} onClose={closeKeyboard} />}
    </div>
  )
}
