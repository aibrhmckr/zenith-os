/* eslint-disable react/prop-types -- Internal controlled console keyboard. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import InputHint from './InputHint'
import { useI18n } from '../hooks/i18n'

/**
 * Three-row EN/TR layouts; the final letter row receives a backspace key at render time.
 */
const LETTERS = {
  en: ['QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM'],
  tr: ['QWERTYUIOPĞÜ', 'ASDFGHJKLŞİ', 'ZXCVBNMÖÇ']
}
/**
 * Numeric/punctuation layout split into code points for key rendering.
 */
const SYMBOLS = [
  '1234567890',
  '!@#$%&*()-_',
  ['.', ',', ':', ';', '?', '/', '\\', "'", '"', '+', '=']
].map(
  /**
   * Project each [ '1234567890', '!@#$%&*()-_', ['.', ',', ':', ';', '?', '/', '\\', "'", '"', '+', '='] ] entry for SYMBOLS; preserve input ordering in the derived collection.
   *
   * @param {*} row - Value supplied by the enclosing operation; interpreted in this callback's local scope.
   */
  (row) => Array.from(row)
)
/**
 * Stable bottom-row action IDs used by keyboard navigation and localized accessible labels.
 */
const TOOLS = ['mode', 'language', 'left', 'right', 'space', 'clear', 'done']
/**
 * Physical arrow-key to shared navigation-direction mapping.
 */
const arrow = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }
/**
 * Render a decorative inline SVG backspace glyph; the owning button supplies the accessible
 * label.
 */
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
/**
 * Render the decorative search/Done glyph without adding a second focusable control.
 */
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
/**
 * Render a controlled TR/EN console keyboard with symbol mode and cursor-aware editing. Parent
 * callbacks own the text and decide when a draft is committed.
 *
 * @param {Object} options - Named inputs for this operation.
 * @param {*} options.value - Input value being normalized, displayed, or committed by this helper.
 * @param {Function} options.onChange - Commit the controlled value/text to the parent.
 * @param {Function} options.onClose - Ask the owner to dismiss this surface and restore its prior focus.
 */
export default function OnScreenKeyboard({ value, onChange, onClose }) {
  const { t, language } = useI18n()
  /**
   * Persisted OSK layout is independent of UI language; fall back to the current UI language on
   * first use.
   */
  const [layout, setLayout] = useState(() => {
    try {
      const saved = localStorage.getItem('zenith-keyboard')
      return saved === 'tr' || saved === 'en' ? saved : language
    } catch {
      return language
    }
  })
  /**
   * Modal dialog and editable text input refs; native input selection must survive clicking
   * virtual keys.
   */
  const dialogRef = useRef(null),
    inputRef = useRef(null)
  /**
   * Immediate UTF-16 text selection used by edit operations before the next render.
   */
  const selection = useRef({ start: value.length, end: value.length })
  /**
   * Render copy of selection used to reapply setSelectionRange after controlled text changes.
   */
  const [caret, setCaret] = useState({ start: value.length, end: value.length })
  /**
   * Whether the editable text field owns physical typing rather than navigation among virtual
   * keys.
   */
  const [editing, setEditing] = useState(true)
  /**
   * Switch between alphabetic and numeric/symbol key rows.
   */
  const [symbols, setSymbols] = useState(false)
  /**
   * Bounded [row,column] virtual-key selection; unequal row lengths clamp horizontal position.
   */
  const [position, setPosition] = useState([0, 0])
  const letters = (symbols ? SYMBOLS : LETTERS[layout]).map(
    /**
     * Project each symbols ? SYMBOLS : LETTERS[layout] entry for letters; preserve input ordering in the derived collection.
     *
     * @param {*} row - Value supplied by the enclosing operation; interpreted in this callback's local scope.
     */
    (row) => Array.from(row)
  )
  const rows = [letters[0], letters[1], [...letters[2], 'erase'], TOOLS]
  /**
   * Open the native OSK dialog and focus editable text on mount.
   */
  useEffect(() => {
    dialogRef.current?.showModal()
    inputRef.current?.focus()
  }, [])
  /**
   * Reapply the saved text selection after controlled value/caret changes before painting.
   */
  useLayoutEffect(() => {
    inputRef.current?.setSelectionRange(caret.start, caret.end)
  }, [value, caret])
  /**
   * Store the current UTF-16 selection offsets in both an immediate ref and render state for
   * cursor restoration.
   *
   * @param {number} start - UTF-16 selection start offset.
   * @param {number} end - UTF-16 selection end offset, defaulting to the start.
   */
  const remember = (start, end = start) => {
    if (selection.current.start === start && selection.current.end === end) return
    const next = { start, end }
    selection.current = next
    setCaret(next)
  }
  /**
   * Replace selected text or insert at the saved cursor, notify the parent, and advance the caret
   * by the inserted string length.
   *
   * @param {string} text - Text inserted at the saved input selection.
   */
  const insert = (text) => {
    const start = Math.min(value.length, selection.current.start),
      end = Math.min(value.length, selection.current.end)
    onChange(value.slice(0, start) + text + value.slice(end))
    remember(start + text.length)
  }
  /**
   * Delete the selection or one preceding Unicode code point without splitting surrogate pairs.
   */
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
  /**
   * Move one Unicode code point left/right, or collapse a selection toward the requested
   * direction.
   *
   * @param {number} step - Signed relative movement, normally -1 or +1.
   */
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
  /**
   * Dispatch character/function keys, persist keyboard layout, and delegate Done to the owning
   * search surface.
   *
   * @param {string|number} key - Action/cache/preference key or input code used by this operation.
   */
  const type = (key) => {
    if (key === 'done') onClose()
    else if (key === 'erase') erase()
    else if (key === 'clear') {
      onChange('')
      remember(0)
    } else if (key === 'mode') {
      setSymbols(
        /**
         * Compute type's next React state from the latest queued value, avoiding stale render snapshots.
         *
         * @param {*} current - Latest queued state or collection entry.
         */
        (current) => !current
      )
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
  /**
   * Navigate uneven keyboard rows with bounded row/column indices and focus the resulting key
   * without scrolling the dashboard.
   *
   * @param {string} direction - Navigation direction: up, down, left, or right.
   */
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
  /**
   * Route controller movement and key actions inside the OSK, replacing handlers when captured
   * text/layout changes.
   */
  useEffect(() => {
    const dialog = dialogRef.current
    /**
     * Consume OSK-only navigation, A insertion, X deletion, and B/Menu dismissal.
     *
     * @param {Object} options - Named inputs for this operation.
     * @param {Object} options.detail - Named inputs for this operation.
     * @param {Function} options.detail.hit - True only for a newly pressed button index.
     * @param {string} options.detail.move - Throttled navigation direction, or null on frames without movement.
     */
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
    /**
     * Release the listeners, timers, or focus ownership acquired by OnScreenKeyboard's effect before it reruns or unmounts.
     */
    return () => dialog.removeEventListener('controller-input', handleController)
  })
  /**
   * Resolve localized accessible labels for function keys while leaving literal characters
   * unchanged.
   *
   * @param {string|number} key - Action/cache/preference key or input code used by this operation.
   */
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
      onCancel={
        /**
         * Handle onCancel on this OnScreenKeyboard control using the current render's values; delegate state/IPC work to its owning component.
         *
         * @param {*} event - DOM/Electron event supplied by the subscription.
         */
        (event) => {
          event.preventDefault()
          onClose()
        }
      }
      onKeyDown={
        /**
         * Handle onKeyDown on this OnScreenKeyboard control using the current render's values; delegate state/IPC work to its owning component.
         *
         * @param {*} event - DOM/Electron event supplied by the subscription.
         */
        (event) => {
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
        }
      }
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
          onFocus={
            /**
             * Handle onFocus on this OnScreenKeyboard control using the current render's values; delegate state/IPC work to its owning component.
             */
            () => setEditing(true)
          }
          onBlur={
            /**
             * Handle onBlur on this OnScreenKeyboard control using the current render's values; delegate state/IPC work to its owning component.
             */
            () => setEditing(false)
          }
          onSelect={
            /**
             * Handle onSelect on this OnScreenKeyboard control using the current render's values; delegate state/IPC work to its owning component.
             *
             * @param {*} event - DOM/Electron event supplied by the subscription.
             */
            (event) =>
              remember(event.currentTarget.selectionStart, event.currentTarget.selectionEnd)
          }
          onChange={
            /**
             * Handle onChange on this OnScreenKeyboard control using the current render's values; delegate state/IPC work to its owning component.
             *
             * @param {*} event - DOM/Electron event supplied by the subscription.
             */
            (event) => {
              onChange(event.target.value)
              remember(event.target.selectionStart, event.target.selectionEnd)
            }
          }
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
        {rows.map(
          /**
           * Project each rows entry for OnScreenKeyboard; preserve input ordering in the derived collection.
           *
           * @param {*} row - Value supplied by the enclosing operation; interpreted in this callback's local scope.
           * @param {*} rowIndex - Value supplied by the enclosing operation; interpreted in this callback's local scope.
           */
          (row, rowIndex) => (
            <div key={rowIndex} className={'osk-row ' + (rowIndex === 3 ? 'osk-functions' : '')}>
              {row.map(
                /**
                 * Project each row entry for OnScreenKeyboard; preserve input ordering in the derived collection.
                 *
                 * @param {*} key - Value supplied by the enclosing operation; interpreted in this callback's local scope.
                 * @param {*} column - Value supplied by the enclosing operation; interpreted in this callback's local scope.
                 */
                (key, column) => (
                  <button
                    key={key}
                    type="button"
                    data-osk-action={key}
                    data-osk-key={`${rowIndex}-${column}`}
                    tabIndex={position[0] === rowIndex && position[1] === column ? 0 : -1}
                    aria-label={label(key)}
                    onPointerDown={
                      /**
                       * Handle onPointerDown on this OnScreenKeyboard control using the current render's values; delegate state/IPC work to its owning component.
                       *
                       * @param {*} event - DOM/Electron event supplied by the subscription.
                       */
                      (event) => event.preventDefault()
                    }
                    onFocus={
                      /**
                       * Handle onFocus on this OnScreenKeyboard control using the current render's values; delegate state/IPC work to its owning component.
                       */
                      () => setPosition([rowIndex, column])
                    }
                    onClick={
                      /**
                       * Handle onClick on this OnScreenKeyboard control using the current render's values; delegate state/IPC work to its owning component.
                       */
                      () => type(key)
                    }
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
                )
              )}
            </div>
          )
        )}
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
