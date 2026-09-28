/* eslint-disable react/prop-types -- Internal core selection panel. */
import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../hooks/i18n'
import OnScreenKeyboard from './OnScreenKeyboard'

export default function CoreBrowser({ onSelect, busy }) {
  const { t } = useI18n()
  const [catalog, setCatalog] = useState(null),
    [query, setQuery] = useState(''),
    [filter, setFilter] = useState(''),
    [keyboard, setKeyboard] = useState(false)
  const input = useRef(null),
    root = useRef(null)
  useEffect(() => {
    let active = true
    window.electronAPI
      .listCores()
      .then((result) => {
        if (active) setCatalog(result)
      })
      .catch((error) => {
        if (active) setCatalog({ cores: [], error: error.message })
      })
    return () => {
      active = false
    }
  }, [])
  useEffect(() => {
    const timer = setTimeout(() => setFilter(query.trim().toLowerCase()), 150)
    return () => clearTimeout(timer)
  }, [query])
  const openKeyboard = () => {
    if (document.documentElement.dataset.inputMode === 'gamepad' && !busy) setKeyboard(true)
  }
  useEffect(() => {
    const node = root.current
    const handler = ({ detail }) => {
      if (detail.hit(2) || (document.activeElement === input.current && detail.hit(0))) {
        setKeyboard(true)
      }
    }
    node.addEventListener('controller-core-search', handler)
    return () => node.removeEventListener('controller-core-search', handler)
  }, [])
  const closeKeyboard = () => {
    setKeyboard(false)
    requestAnimationFrame(() => input.current?.focus())
  }
  const results = (catalog?.cores || []).filter((core) =>
    (core.name + ' ' + core.fileName).toLowerCase().includes(filter)
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
        onChange={(event) => setQuery(event.target.value)}
        onClick={openKeyboard}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            root.current.querySelector('[data-core-choice]')?.focus()
          }
        }}
      />
      {!catalog && <p role="status">{t('loading')}</p>}
      {catalog?.offline && <p className="mb-3 text-amber-200">{t('coreOffline')}</p>}
      {catalog && !results.length && <p role="status">{catalog.error || t('noResults')}</p>}
      <div data-core-results className="flex max-h-[40vh] flex-col gap-2 overflow-y-auto p-2">
        {results.map((core) => (
          <button
            key={core.fileName}
            data-core-choice={core.fileName}
            disabled={busy}
            className="console-button justify-between text-left"
            onClick={() => onSelect(core.fileName)}
          >
            <span>
              {core.name}
              <small className="block text-white/50">{core.fileName}</small>
            </span>
            <span>{core.installed ? t('ready') : t('install')}</span>
          </button>
        ))}
      </div>
      {keyboard && <OnScreenKeyboard value={query} onChange={setQuery} onClose={closeKeyboard} />}
    </div>
  )
}
