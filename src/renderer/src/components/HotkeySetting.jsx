/* eslint-disable react/prop-types -- Internal hotkey editor. */
import { useContext, useEffect, useRef, useState } from 'react'
import { InputContext } from '../hooks/inputContext'
import { useI18n } from '../hooks/i18n'
import { PAD_LABELS, keyboardCode, validKey, keyLabel } from '../../../shared/hotkeys'
import { KeyBadge } from './InputHint'
/**
 * Capture two distinct keys for the active input device, preserving the old mapping until onSave
 * succeeds. B/Escape cancels without persisting a partial chord.
 *
 * @param {Object} options - Named inputs for this operation.
 * @param {Object} options.hotkeys - Normalized gamepad indices and physical keyboard-code pair.
 * @param {Function} options.onSave - Persist the completed hotkey mapping; returns a Promise.
 */
export default function HotkeySetting({ hotkeys, onSave }) {
  const mode = useContext(InputContext),
    { t } = useI18n()
  /**
   * Null outside listening; otherwise device and collected keys form an uncommitted two-step
   * draft. Error is displayed separately.
   */
  const [editing, setEditing] = useState(null),
    [error, setError] = useState('')
  /**
   * Event root, return-focus trigger, and synchronous saving lock prevent duplicate persistence
   * during key bursts.
   */
  const root = useRef(null),
    trigger = useRef(null),
    saving = useRef(false)
  /**
   * End listening and restore focus to the combination editor trigger.
   */
  const close = () => {
    setEditing(null)
    requestAnimationFrame(
      /**
       * Synchronize close's focus/animation work with the next frame rather than an intermediate DOM state.
       */
      () => trigger.current?.focus()
    )
  }
  /**
   * During editing, capture keyboard and routed gamepad input; persist only a complete pair and
   * remove listeners on cancellation/unmount.
   */
  useEffect(() => {
    if (!editing) return
    /**
     * Collect a distinct first/second key; serialize saving the completed pair and display
     * persistence errors without leaving the editor locked.
     *
     * @param {string|number} key - Action/cache/preference key or input code used by this operation.
     */
    const accept = async (key) => {
      if (saving.current || editing.keys.includes(key)) return
      const keys = [...editing.keys, key]
      if (keys.length === 1) {
        setEditing({ ...editing, keys })
        return
      }
      saving.current = true
      try {
        await onSave({ ...hotkeys, [editing.device]: keys })
        close()
      } catch (error) {
        setError(error.message)
        close()
      } finally {
        saving.current = false
      }
    }
    /**
     * Consume keyboard events during listening, reserve Escape for cancel, and accept only
     * nonrepeated supported physical key codes.
     *
     * @param {Object} event - Electron or DOM event associated with this operation.
     */
    const keydown = (event) => {
      event.preventDefault()
      event.stopImmediatePropagation()
      if (event.key === 'Escape') {
        if (!saving.current) close()
        return
      }
      const code = keyboardCode(event)
      if (editing.device === 'keyboard' && !event.repeat && validKey(code)) void accept(code)
    }
    /**
     * Consume the dialog-routed gamepad frame, reserve B for cancel, and accept a newly pressed
     * standard button.
     *
     * @param {Object} options - Named inputs for this operation.
     * @param {Object} options.detail - CustomEvent payload carrying controller frame data.
     */
    const pad = ({ detail }) => {
      if (detail.hit(1)) {
        if (!saving.current) close()
        return
      }
      if (editing.device === 'gamepad') {
        const key = PAD_LABELS.findIndex(
          /**
           * Locate the matching PAD_LABELS entry by index so key can maintain selection without retaining a stale DOM reference.
           *
           * @param {*} _ - Value supplied by the enclosing operation; interpreted in this callback's local scope.
           * @param {*} i - Zero-based collection index.
           */
          (_, i) => i !== 1 && detail.hit(i)
        )
        if (key >= 0) void accept(key)
      }
    }
    const node = root.current
    window.addEventListener('keydown', keydown, true)
    node.addEventListener('controller-hotkey', pad)
    /**
     * Release the listeners, timers, or focus ownership acquired by HotkeySetting's effect before it reruns or unmounts.
     */
    return () => {
      window.removeEventListener('keydown', keydown, true)
      node.removeEventListener('controller-hotkey', pad)
    }
  }, [editing, hotkeys, onSave])
  const keys = editing?.keys || hotkeys[mode]
  return (
    <div ref={root} data-hotkey-listening={editing ? '' : undefined} className="my-6">
      <button
        ref={trigger}
        data-hotkey-setting
        className="settings-toggle"
        disabled={!!editing}
        onClick={
          /**
           * Handle onClick on this HotkeySetting control using the current render's values; delegate state/IPC work to its owning component.
           */
          () => {
            setError('')
            setEditing({ device: document.documentElement.dataset.inputMode || mode, keys: [] })
          }
        }
      >
        <span>{t('menuHotkey')}</span>
        <span className="flex items-center gap-2">
          {(keys.length ? keys : mode === 'keyboard' ? ['Escape', 'F10'] : hotkeys.gamepad).map(
            /**
             * Project each keys.length ? keys : mode === 'keyboard' ? ['Escape', 'F10'] : hotkeys.gamepad entry for HotkeySetting; preserve input ordering in the derived collection.
             *
             * @param {*} key - Value supplied by the enclosing operation; interpreted in this callback's local scope.
             * @param {*} i - Zero-based collection index.
             */
            (key, i) => (
              <span key={i} className="flex items-center gap-2">
                {i > 0 && (mode === 'keyboard' && !hotkeys.keyboard.length ? '/' : '+')}
                <KeyBadge
                  keyboard={typeof key === 'string' ? keyLabel(key) : ''}
                  gamepad={PAD_LABELS[key] || ''}
                />
              </span>
            )
          )}
        </span>
      </button>
      {editing && (
        <div role="status" className="mt-3 flex gap-3" aria-live="polite">
          {[0, 1].map(
            /**
             * Project each [0, 1] entry for HotkeySetting; preserve input ordering in the derived collection.
             *
             * @param {*} i - Zero-based collection index.
             */
            (i) => (
              <div
                key={i}
                className={
                  'rounded-xl border p-4 ' +
                  (editing.keys.length === i
                    ? 'animate-pulse border-blue-400 bg-blue-500/20'
                    : 'border-white/20')
                }
              >
                {editing.keys[i] !== undefined
                  ? editing.device === 'gamepad'
                    ? PAD_LABELS[editing.keys[i]]
                    : keyLabel(editing.keys[i])
                  : t(i === 0 ? 'pressFirst' : 'pressSecond')}
              </div>
            )
          )}
          <span>{t('hotkeyCancel')}</span>
        </div>
      )}
      {error && (
        <p role="alert" className="text-rose-300">
          {error}
        </p>
      )}
    </div>
  )
}
