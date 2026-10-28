/* eslint-disable react/prop-types -- Internal picker with Main-owned capability tokens. */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import ConsoleModal from './ConsoleModal'
import InputHint from './InputHint'
import { useI18n } from '../hooks/i18n'
import { emitSound } from '../hooks/useSoundEffects'

/** Original line icons; no remote dependency. */
function FileIcon({ type = 'game' }) {
  const paths = {
    folder: <path d="M3 7V5h6l2 2h10v12H3V7Z" />,
    image: (
      <>
        <rect x="3" y="3" width="18" height="18" rx="3" />
        <circle cx="8" cy="8" r="1.5" />
        <path d="m3 17 6-6 5 5 3-3 4 4" />
      </>
    ),
    video: (
      <>
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="M7 3v18M17 3v18M3 8h4M3 16h4M17 8h4M17 16h4m-11-7 4 3-4 3Z" />
      </>
    ),
    drive: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="3" />
        <path d="M3 14h18M16 17h2M6 17h1" />
      </>
    ),
    home: <path d="m3 10 9-7 9 7M5 9v12h14V9M9 21v-8h6v8" />,
    desktop: (
      <>
        <rect x="2" y="3" width="20" height="14" rx="2" />
        <path d="M8 21h8m-4-4v4" />
      </>
    ),
    downloads: <path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4" />,
    game: (
      <>
        <circle cx="12" cy="12" r="9" />
        <circle cx="12" cy="12" r="2" />
        <path d="M12 5a7 7 0 0 1 7 7M5 12a7 7 0 0 0 7 7" />
      </>
    )
  }
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[type] || paths.game}
    </svg>
  )
}
const formatters = new Map()
function formats(language) {
  if (!formatters.has(language))
    formatters.set(language, {
      size: new Intl.NumberFormat(language, { maximumFractionDigits: 1 }),
      date: new Intl.DateTimeFormat(language, { dateStyle: 'medium' })
    })
  return formatters.get(language)
}
function sizeLabel(size, language) {
  if (!Number.isFinite(size)) return '—'
  const unit = Math.min(4, Math.floor(Math.log(Math.max(1, size)) / Math.log(1024)))
  return `${formats(language).size.format(size / 1024 ** unit)} ${['B', 'KB', 'MB', 'GB', 'TB'][unit]}`
}
/** Folder metadata is requested after a short focus delay and never blocks directory navigation. */
function FolderPreview({ entry }) {
  const { t, language } = useI18n()
  const [summary, setSummary] = useState(null)
  useEffect(() => {
    let live = true
    const timer = setTimeout(() => {
      window.electronAPI
        .summarizeFolder(entry.summaryToken)
        .then((value) => {
          if (live) setSummary(value)
        })
        .catch(() => {
          if (live) setSummary({ success: false })
        })
    }, 180)
    return () => {
      live = false
      clearTimeout(timer)
      void window.electronAPI.summarizeFolder(null).catch(() => {})
    }
  }, [entry.summaryToken])
  const ready = summary?.success && !summary.canceled
  return (
    <div className="file-folder-preview" data-folder-summary aria-busy={!summary}>
      <span className="file-folder-emblem">
        <FileIcon type="folder" />
      </span>
      <span className="file-folder-type">{t('fileFolder')}</span>
      <h4>{entry.name}</h4>
      {!summary ? (
        <p role="status">{t('fileScanningFolder')}</p>
      ) : ready ? (
        <>
          <div className="file-folder-metrics">
            <div>
              <strong data-folder-items>
                {new Intl.NumberFormat(language).format(summary.files + summary.folders)}
              </strong>
              <span>{t('fileFolderItems')}</span>
            </div>
            <div>
              <strong data-folder-size>{sizeLabel(summary.size, language)}</strong>
              <span>{t('fileTotalSize')}</span>
            </div>
          </div>
          <p className="file-folder-breakdown">
            {summary.files} {t(summary.files === 1 ? 'fileSingleFile' : 'fileFiles')} ·{' '}
            {summary.folders} {t(summary.folders === 1 ? 'fileSingleFolder' : 'fileFolders')}
          </p>
          <p className="file-folder-note">
            {t(summary.partial ? 'fileFolderPartial' : 'fileFolderRecursive')}
          </p>
        </>
      ) : (
        <p>{t('fileFolderUnavailable')}</p>
      )}
    </div>
  )
}
/** Keying by selection stops old video and rejects stale IPC/decoder results. */
function LivePreview({ entry }) {
  const { t } = useI18n()
  const [result, setResult] = useState(null),
    [failed, setFailed] = useState(false),
    [dimensions, setDimensions] = useState(null)
  const video = useRef(null)
  const attachVideo = useCallback((node) => {
    if (video.current && video.current !== node) {
      video.current.pause()
      video.current.removeAttribute('src')
      video.current.load()
    }
    video.current = node
    if (node) node.volume = 0
  }, [])
  useEffect(() => {
    let live = true
    const media = ['image', 'video'].includes(entry?.type)
    const timer = setTimeout(() => {
      window.electronAPI
        .previewFile(media ? entry.token : null)
        .then((value) => {
          if (live) setResult(value)
        })
        .catch(() => {
          if (live) setFailed(true)
        })
    }, 160)
    return () => {
      clearTimeout(timer)
      live = false
      void window.electronAPI.previewFile(null).catch(() => {})
    }
  }, [entry?.token, entry?.type])
  const unavailable = failed || result?.success === false
  return (
    <div className="file-preview-art" data-file-preview>
      {result?.url && !unavailable ? (
        entry.type === 'image' ? (
          <img
            src={result.url}
            alt={entry.name}
            onError={() => setFailed(true)}
            onLoad={(e) =>
              setDimensions(`${e.currentTarget.naturalWidth} × ${e.currentTarget.naturalHeight}`)
            }
          />
        ) : (
          <video
            src={result.url}
            muted
            loop
            autoPlay
            playsInline
            preload="metadata"
            ref={attachVideo}
            onError={() => setFailed(true)}
            onLoadedMetadata={(e) =>
              setDimensions(`${e.currentTarget.videoWidth} × ${e.currentTarget.videoHeight}`)
            }
          />
        )
      ) : (
        <div className="file-preview-placeholder">
          <FileIcon type={entry?.directory ? 'folder' : entry?.type} />
          <span>
            {t(
              unavailable
                ? 'filePreviewUnavailable'
                : entry?.directory
                  ? 'fileFolder'
                  : 'filePreview'
            )}
          </span>
        </div>
      )}
      {dimensions && !unavailable && (
        <span className="file-resolution" data-file-resolution>
          {dimensions}
        </span>
      )}
    </div>
  )
}

/** Three focus columns retain their row when switching location/list/action. */
export default function FileBrowser({ kind, onFinish }) {
  const { t, language } = useI18n(),
    root = useRef(null),
    revision = useRef(0)
  const remembered = useRef([0, 0, 0])
  const [locations, setLocations] = useState([])
  const [listing, setListing] = useState({ path: null, parent: null, entries: [] })
  const [focused, setFocused] = useState(null),
    [busy, setBusy] = useState(true),
    [error, setError] = useState('')
  const load = async (path, offset = 0, initial = false) => {
    const generation = ++revision.current
    setBusy(true)
    setError('')
    setFocused(null)
    try {
      let result = await window.electronAPI.listFiles({ kind, path, offset })
      if (generation !== revision.current) return
      if (!result.success) throw Error(result.error)
      if (path === null) {
        setLocations(result.entries)
        const home = initial && result.entries.find((entry) => entry.shortcut === 'home')
        if (home) {
          result = await window.electronAPI.listFiles({ kind, path: home.path, offset: 0 })
          if (generation !== revision.current) return
          if (!result.success) throw Error(result.error)
        } else {
          // Locations belong exclusively to the sidebar, never duplicate them as file rows.
          result = { path: null, parent: null, entries: [] }
        }
      }
      setListing(result)
      setFocused(result.entries[0] || null)
      remembered.current[1] = 0
    } catch (failure) {
      if (generation === revision.current) setError(failure.message)
    } finally {
      if (generation === revision.current) setBusy(false)
    }
  }
  useEffect(() => {
    const timer = setTimeout(() => void load(null, 0, true), 0)
    return () => {
      clearTimeout(timer)
      // Invalidates outstanding directory IPC, not a DOM reference.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      revision.current++
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    if (!busy)
      (
        (listing.path === null && root.current?.querySelector('[data-file-location]')) ||
        root.current?.querySelector('[data-file-entry]') ||
        root.current?.querySelector('[data-file-up]')
      )?.focus({ preventScroll: true })
  }, [listing, busy])
  const up = () => {
    if (!busy) {
      if (listing.path === null) onFinish(null)
      else void load(listing.parent)
    }
  }
  const confirm = (entry = focused) => {
    if (!busy && entry?.token) {
      emitSound('toggle')
      onFinish([entry.token])
    }
  }
  const choose = (entry) => {
    if (!busy) {
      if (entry.directory) {
        emitSound('toggle')
        void load(entry.path)
      } else confirm(entry)
    }
  }
  const controls = (column) => [
    ...(root.current?.querySelectorAll(`[data-file-column="${column}"] button:not(:disabled)`) ||
      [])
  ]
  const focusControl = (next) => {
    if (!next) return
    const column = Number(next.closest('[data-file-column]').dataset.fileColumn)
    remembered.current[column] = controls(column).indexOf(next)
    // Hidden/restored Electron windows may move DOM focus without dispatching focusin.
    // Keep the controller selection explicit so X always imports the highlighted row.
    if (next.hasAttribute('data-file-entry')) {
      const entry = listing.entries.find((item) => item.name === next.dataset.fileName)
      if (entry) setFocused(entry)
    }
    next.focus({ preventScroll: true })
    next.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }
  const focusColumn = (column) => {
    const buttons = controls(column)
    const next = buttons[Math.min(remembered.current[column], buttons.length - 1)]
    focusControl(next)
  }
  const move = (direction) => {
    if (busy) return
    const column = Number(
      document.activeElement?.closest('[data-file-column]')?.dataset.fileColumn ?? 1
    )
    if (direction === 'left' || direction === 'right') {
      focusColumn(Math.max(0, Math.min(2, column + (direction === 'right' ? 1 : -1))))
      return
    }
    const buttons = controls(column),
      index = Math.max(0, buttons.indexOf(document.activeElement))
    const next =
      buttons[Math.max(0, Math.min(buttons.length - 1, index + (direction === 'down' ? 1 : -1)))]
    focusControl(next)
  }
  useEffect(() => {
    const element = root.current
    const input = ({ detail }) => {
      if (detail.hit(1)) up()
      else if (detail.hit(2)) confirm()
      else if (detail.hit(4)) move('left')
      else if (detail.hit(5)) move('right')
      else if (detail.move) move(detail.move)
      else if (!busy && detail.hit(0)) {
        if (!element.contains(document.activeElement)) focusColumn(1)
        document.activeElement?.click()
      }
    }
    element.addEventListener('file-navigation', input)
    return () => element.removeEventListener('file-navigation', input)
  })
  const label = (entry) =>
    entry.shortcut && entry.shortcut !== 'drive' ? t('fileLocation_' + entry.shortcut) : entry.name
  const date = (value) =>
    Number.isFinite(value) ? formats(language).date.format(value) : t('fileMetadataUnavailable')
  const title = (
    <span className="file-browser-heading">
      <span>{t('fileBrowser')}</span>
      <span className="file-breadcrumbs" data-file-breadcrumbs aria-label={t('filePath')}>
        {listing.breadcrumbs?.length
          ? listing.breadcrumbs.map((part, i) => (
              <span key={part.path}>
                {i > 0 && <span aria-hidden="true"> › </span>}
                {part.name.replace(/^([a-z]:)[\\/]$/i, '$1')}
              </span>
            ))
          : t('fileDrives')}
      </span>
    </span>
  )
  return (
    <ConsoleModal title={title} kind="fileBrowser" onClose={() => onFinish(null)}>
      <div
        ref={root}
        data-file-browser
        className="file-browser-shell"
        onFocusCapture={(e) => {
          const column = e.target.closest('[data-file-column]')?.dataset.fileColumn
          if (column !== undefined)
            remembered.current[Number(column)] = Math.max(
              0,
              controls(Number(column)).indexOf(e.target)
            )
          if (e.target.matches('button')) emitSound('navigate')
        }}
        onKeyDown={(e) => {
          if (e.key.startsWith('Arrow') || ['PageUp', 'PageDown'].includes(e.key)) {
            e.preventDefault()
            e.stopPropagation()
            move(
              e.key === 'PageUp'
                ? 'left'
                : e.key === 'PageDown'
                  ? 'right'
                  : e.key.slice(5).toLowerCase()
            )
          } else if (e.key === 'Backspace') {
            e.preventDefault()
            e.stopPropagation()
            up()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            onFinish(null)
          } else if (e.key.toLowerCase() === 'x') {
            e.preventDefault()
            e.stopPropagation()
            confirm()
          } else if (e.key === 'Enter') {
            e.preventDefault()
            e.stopPropagation()
            if (!e.repeat) document.activeElement?.click()
          }
        }}
      >
        <div className="file-browser-columns">
          <aside data-file-column="0" className="file-locations" aria-label={t('fileQuickAccess')}>
            <h3>{t('fileQuickAccess')}</h3>
            {locations
              .filter((e) => e.shortcut !== 'drive')
              .map((entry) => (
                <button
                  key={entry.path}
                  data-file-location={entry.shortcut}
                  aria-current={listing.path === entry.path ? 'location' : undefined}
                  title={entry.path}
                  disabled={busy}
                  className="file-location"
                  onClick={() => choose(entry)}
                >
                  <FileIcon type={entry.shortcut} />
                  <span>{label(entry)}</span>
                </button>
              ))}
            <h3>{t('fileDrives')}</h3>
            {locations
              .filter((e) => e.shortcut === 'drive')
              .map((entry) => (
                <button
                  key={entry.path}
                  data-file-location="drive"
                  aria-current={listing.path === entry.path ? 'location' : undefined}
                  title={entry.path}
                  disabled={busy}
                  className="file-location"
                  onClick={() => choose(entry)}
                >
                  <FileIcon type="drive" />
                  <span>
                    {entry.name}
                    <small>{t('fileLocalDrive')}</small>
                  </span>
                </button>
              ))}
          </aside>
          <section data-file-column="1" className="file-list-panel" aria-label={t('fileList')}>
            <div className="file-list-heading">
              <h3>{t('fileList')}</h3>
              <button data-file-up disabled={busy} onClick={up} aria-label={t('fileParent')}>
                ↑ {t('fileParent')}
              </button>
            </div>
            <div className="file-list-scroll">
              {busy && <p role="status">{t('loading')}</p>}
              {error && (
                <p role="alert" className="text-rose-300">
                  {error}
                </p>
              )}
              {!busy && !error && !listing.entries.length && (
                <p className="file-empty">
                  {t(listing.path === null ? 'fileChooseLocation' : 'fileEmpty')}
                </p>
              )}
              {listing.entries.map((entry) => (
                <button
                  key={entry.path || entry.token}
                  data-file-entry
                  data-file-name={entry.name}
                  disabled={busy}
                  className="file-row"
                  aria-pressed={focused === entry}
                  onFocus={() => setFocused(entry)}
                  onClick={() => choose(entry)}
                >
                  <span className="file-row-icon">
                    <FileIcon type={entry.directory ? entry.shortcut || 'folder' : entry.type} />
                  </span>
                  <span className="file-row-name">
                    {label(entry)}
                    <small>
                      {entry.directory
                        ? t('fileFolder')
                        : entry.name.split('.').at(-1).toUpperCase()}
                    </small>
                  </span>
                  <span className="file-row-meta">
                    <span data-file-size>
                      {entry.directory ? t('fileFolder') : sizeLabel(entry.size, language)}
                    </span>
                    <time
                      dateTime={
                        Number.isFinite(entry.modified)
                          ? new Date(entry.modified).toISOString()
                          : undefined
                      }
                    >
                      {date(entry.modified)}
                    </time>
                  </span>
                </button>
              ))}
              <div className="file-pagination">
                {listing.previousOffset != null && (
                  <button
                    className="console-button"
                    disabled={busy}
                    onClick={() => load(listing.path, listing.previousOffset)}
                  >
                    {t('filePrevious')}
                  </button>
                )}
                {listing.nextOffset != null && (
                  <button
                    className="console-button"
                    disabled={busy}
                    onClick={() => load(listing.path, listing.nextOffset)}
                  >
                    {t('fileMore')}
                  </button>
                )}
              </div>
            </div>
          </section>
          <aside data-file-column="2" className="file-details" aria-label={t('filePreview')}>
            <h3>{t('filePreview')}</h3>
            {focused?.directory ? (
              <FolderPreview key={focused.summaryToken} entry={focused} />
            ) : null}
            <div hidden={!!focused?.directory}>
              <LivePreview key={focused?.token || focused?.path || 'none'} entry={focused} />
            </div>
            <div className="file-detail-copy">
              {!focused?.directory && (
                <h4 data-file-detail-name>{focused ? label(focused) : t('fileChoose')}</h4>
              )}
              {focused?.platform && <span className="file-platform">{focused.platform}</span>}
              {focused && (
                <dl>
                  {!focused.directory && (
                    <div>
                      <dt>{t('fileType')}</dt>
                      <dd>
                        {focused.directory
                          ? t('fileFolder')
                          : focused.name.split('.').at(-1).toUpperCase()}
                      </dd>
                    </div>
                  )}
                  {!focused.directory && (
                    <div>
                      <dt>{t('fileSize')}</dt>
                      <dd>{sizeLabel(focused.size, language)}</dd>
                    </div>
                  )}
                  {focused.modified && (
                    <div>
                      <dt>{t('fileModified')}</dt>
                      <dd>{date(focused.modified)}</dd>
                    </div>
                  )}
                </dl>
              )}
            </div>
            <button
              data-file-confirm
              className="file-confirm"
              disabled={busy || !focused?.token}
              onClick={() => confirm()}
            >
              <InputHint keyboard="X" gamepad="X">
                {t('fileImport')}
              </InputHint>
            </button>
          </aside>
        </div>
        <footer className="file-browser-footer">
          <InputHint keyboard="Enter" gamepad="A">
            {t('fileSelect')}
          </InputHint>
          <InputHint keyboard="Backspace" gamepad="B">
            {t('fileParent')}
          </InputHint>
          <InputHint keyboard="X" gamepad="X">
            {t('fileConfirm')}
          </InputHint>
          <InputHint keyboard="PgUp / PgDn" gamepad="LB / RB">
            {t('fileSections')}
          </InputHint>
        </footer>
      </div>
    </ConsoleModal>
  )
}
