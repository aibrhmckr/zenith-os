/* eslint-disable react/prop-types -- Internal hotkey editor. */
import { useContext, useEffect, useRef, useState } from 'react'
import { InputContext } from '../hooks/inputContext'
import { useI18n } from '../hooks/i18n'
import { PAD_LABELS, keyboardCode, validKey, keyLabel } from '../../../shared/hotkeys'
import { KeyBadge } from './InputHint'
export default function HotkeySetting({ hotkeys, onSave }) {
  const mode = useContext(InputContext),
    { t } = useI18n()
  const [editing, setEditing] = useState(null),
    [error, setError] = useState('')
  const root = useRef(null),
    trigger = useRef(null),
    saving = useRef(false)
  const close = () => {
    setEditing(null)
    requestAnimationFrame(() => trigger.current?.focus())
  }
  useEffect(() => {
    if (!editing) return
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
    const pad = ({ detail }) => {
      if (detail.hit(1)) {
        if (!saving.current) close()
        return
      }
      if (editing.device === 'gamepad') {
        const key = PAD_LABELS.findIndex((_, i) => i !== 1 && detail.hit(i))
        if (key >= 0) void accept(key)
      }
    }
    const node = root.current
    window.addEventListener('keydown', keydown, true)
    node.addEventListener('controller-hotkey', pad)
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
        onClick={() => {
          setError('')
          setEditing({ device: document.documentElement.dataset.inputMode || mode, keys: [] })
        }}
      >
        <span>{t('menuHotkey')}</span>
        <span className="flex items-center gap-2">
          {(keys.length ? keys : mode === 'keyboard' ? ['Escape', 'F10'] : hotkeys.gamepad).map(
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
          {[0, 1].map((i) => (
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
          ))}
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
