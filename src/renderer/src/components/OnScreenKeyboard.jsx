/* eslint-disable react/prop-types -- Internal controlled console keyboard. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import InputHint from './InputHint'
import { useI18n } from '../hooks/i18n'

const LETTERS = {
  en: ['QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM'],
  tr: ['QWERTYUIOPĞÜ', 'ASDFGHJKLŞİ', 'ZXCVBNMÖÇ']
}
const SYMBOLS = [
  '1234567890',
  '!@#$%&*()-_',
  ['.', ',', ':', ';', '?', '/', '\\', "'", '"', '+', '=']
].map((row) => Array.from(row))
const TOOLS = ['mode', 'language', 'left', 'right', 'space', 'clear', 'done']
const arrow = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }
function BackspaceIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="23"
      height="23"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      aria-hidden="true"
    >
      <path d="M9 5h12v14H9L2 12Z" />
      <path d="m12 9 6 6m0-6-6 6" />
    </svg>
  )
}
function SearchIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="21"
      height="21"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m16 16 5 5" />
    </svg>
  )
}
export default function OnScreenKeyboard({ value, onChange, onClose }) {
  const { t, language } = useI18n()
  const [layout, setLayout] = useState(() => {
    try {
      const saved = localStorage.getItem('zenith-keyboard')
      return saved === 'tr' || saved === 'en' ? saved : language
    } catch {
      return language
    }
  })
  const dialogRef = useRef(null),
    inputRef = useRef(null)
  const selection = useRef({ start: value.length, end: value.length })
  const [caret, setCaret] = useState({ start: value.length, end: value.length })
  const [editing, setEditing] = useState(true)
  const [symbols, setSymbols] = useState(false)
  const [position, setPosition] = useState([0, 0])
  const letters = (symbols ? SYMBOLS : LETTERS[layout]).map((row) => Array.from(row))
  const rows = [letters[0], letters[1], [...letters[2], 'erase'], TOOLS]
  useEffect(() => {
    dialogRef.current?.showModal()
    inputRef.current?.focus()
  }, [])
  useLayoutEffect(() => {
    inputRef.current?.setSelectionRange(caret.start, caret.end)
  }, [value, caret])
  const remember = (start, end = start) => {
    if (selection.current.start === start && selection.current.end === end) return
    const next = { start, end }
    selection.current = next
    setCaret(next)
  }
  const insert = (text) => {
    const start = Math.min(value.length, selection.current.start),
      end = Math.min(value.length, selection.current.end)
    onChange(value.slice(0, start) + text + value.slice(end))
    remember(start + text.length)
  }
  const erase = () => {
    const { start, end } = selection.current
    if (start !== end) {
      insert('')
      return
    }
    const previous = Array.from(value.slice(0, start)).at(-1) || ''
    onChange(value.slice(0, start - previous.length) + value.slice(end))
    remember(start - previous.length)
  }
  const cursor = (step) => {
    const { start, end } = selection.current
    if (start !== end) {
      remember(step < 0 ? start : end)
      return
    }
    const character =
      step < 0 ? Array.from(value.slice(0, start)).at(-1) : Array.from(value.slice(start))[0]
    remember(Math.max(0, Math.min(value.length, start + step * (character?.length || 0))))
  }
  const type = (key) => {
    if (key === 'done') onClose()
    else if (key === 'erase') erase()
    else if (key === 'clear') {
      onChange('')
      remember(0)
    } else if (key === 'mode') {
      setSymbols((current) => !current)
      setPosition([3, 0])
    } else if (key === 'language') {
      const next = layout === 'tr' ? 'en' : 'tr'
      setLayout(next)
      try {
        localStorage.setItem('zenith-keyboard', next)
      } catch {
        /* Optional persistence. */
      }
      setPosition([3, 1])
    } else if (key === 'left' || key === 'right') cursor(key === 'left' ? -1 : 1)
    else insert(key === 'space' ? ' ' : key)
  }
  const move = (direction) => {
    const [row, column] = position
    const nextRow =
      direction === 'up'
        ? Math.max(0, row - 1)
        : direction === 'down'
          ? Math.min(rows.length - 1, row + 1)
          : row
    const nextColumn =
      direction === 'left'
        ? Math.max(0, column - 1)
        : direction === 'right'
          ? Math.min(rows[row].length - 1, column + 1)
          : column
    const next = [nextRow, Math.min(nextColumn, rows[nextRow].length - 1)]
    setPosition(next)
    dialogRef.current
      ?.querySelector(`[data-osk-key="${next.join('-')}"]`)
      ?.focus({ preventScroll: true })
  }
  useEffect(() => {
    const dialog = dialogRef.current
    const handleController = ({ detail: { hit, move: direction } }) => {
      if (hit(1) || hit(9)) {
        onClose()
        return
      }
      if (direction) move(direction)
      else if (hit(2)) erase()
      else if (hit(0)) type(rows[position[0]][position[1]])
    }
    dialog.addEventListener('controller-input', handleController)
    return () => dialog.removeEventListener('controller-input', handleController)
  })
  const label = (key) =>
    ({
      clear: t('clear'),
      space: t('space'),
      erase: t('erase'),
      done: t('done'),
      left: t('cursorLeft'),
      right: t('cursorRight'),
      language: t('keyboardLanguage') + ': ' + layout.toUpperCase(),
      mode: t(symbols ? 'letters' : 'symbols')
    })[key] || key
  return (
    <dialog
      ref={dialogRef}
      data-osk
      aria-labelledby="osk-title"
      className="console-keyboard text-white"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Escape') {
          event.preventDefault()
          onClose()
          return
        }
        if (event.target === inputRef.current) {
          if (event.key === 'Enter') {
            event.preventDefault()
            onClose()
          }
          return
        }
        if (arrow[event.key]) {
          event.preventDefault()
          move(arrow[event.key])
        } else if (event.key === 'Backspace') {
          event.preventDefault()
          erase()
        } else if (
          event.key.length === 1 &&
          event.key !== ' ' &&
          !event.ctrlKey &&
          !event.altKey &&
          !event.metaKey
        ) {
          event.preventDefault()
          insert(event.key)
        }
      }}
    >
      <header className="mb-4 flex items-center justify-between gap-6">
        <h2 id="osk-title" className="text-lg font-semibold">
          {t('oskTitle')}
        </h2>
        <button onClick={onClose}>
          <InputHint keyboard="Esc" gamepad="B">
            {t('close')}
          </InputHint>
        </button>
      </header>
      <div className="relative mb-4">
        <input
          ref={inputRef}
          aria-label={t('search')}
          value={value}
          onFocus={() => setEditing(true)}
          onBlur={() => setEditing(false)}
          onSelect={(event) =>
            remember(event.currentTarget.selectionStart, event.currentTarget.selectionEnd)
          }
          onChange={(event) => {
            onChange(event.target.value)
            remember(event.target.selectionStart, event.target.selectionEnd)
          }}
          className={'osk-input ' + (editing ? '' : 'text-transparent')}
        />
        {!editing && (
          <div aria-hidden="true" data-osk-caret className="osk-caret-preview">
            <span>{value.slice(0, caret.start)}</span>
            <span className="osk-caret" />
            <span className="bg-sky-500/30">{value.slice(caret.start, caret.end)}</span>
            <span>{value.slice(caret.end)}</span>
          </div>
        )}
      </div>
      <div className="space-y-2">
        {rows.map((row, rowIndex) => (
          <div key={rowIndex} className={'osk-row ' + (rowIndex === 3 ? 'osk-functions' : '')}>
            {row.map((key, column) => (
              <button
                key={key}
                type="button"
                data-osk-action={key}
                data-osk-key={`${rowIndex}-${column}`}
                tabIndex={position[0] === rowIndex && position[1] === column ? 0 : -1}
                aria-label={label(key)}
                onPointerDown={(event) => event.preventDefault()}
                onFocus={() => setPosition([rowIndex, column])}
                onClick={() => type(key)}
                className={
                  'osk-key ' +
                  (key === 'space' ? 'osk-space ' : '') +
                  (position[0] === rowIndex && position[1] === column ? 'osk-selected' : '')
                }
              >
                {key === 'erase' ? (
                  <BackspaceIcon />
                ) : key === 'done' ? (
                  <>
                    <SearchIcon />
                    <span>
                      {t('searchAction')} / {t('done')}
                    </span>
                  </>
                ) : key === 'language' ? (
                  <>
                    <svg
                      width="22"
                      height="22"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      aria-hidden="true"
                    >
                      <circle cx="12" cy="12" r="9" />
                      <ellipse cx="12" cy="12" rx="4" ry="9" />
                      <path d="M3 12h18M5 7h14M5 17h14" />
                    </svg>
                    <span>{layout.toUpperCase()}</span>
                  </>
                ) : key === 'mode' ? (
                  symbols ? (
                    'ABC'
                  ) : (
                    '?123'
                  )
                ) : key === 'left' ? (
                  '←'
                ) : key === 'right' ? (
                  '→'
                ) : (
                  label(key)
                )}
              </button>
            ))}
          </div>
        ))}
      </div>
      <footer className="mt-4 flex flex-wrap justify-center gap-6">
        <InputHint keyboard="↑↓←→" gamepad="D-Pad">
          {t('navigate')}
        </InputHint>
        <InputHint keyboard="Enter" gamepad="A">
          {t('type')}
        </InputHint>
        <InputHint keyboard="⌫" gamepad="X">
          {t('erase')}
        </InputHint>
        <InputHint keyboard="Esc" gamepad="Menu">
          {t('done')}
        </InputHint>
      </footer>
    </dialog>
  )
}
