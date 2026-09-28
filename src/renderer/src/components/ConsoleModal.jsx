/* eslint-disable react/prop-types -- Internal modal shared by console panels. */
import { useEffect, useLayoutEffect, useRef, useCallback } from 'react'
import { emitSound } from '../hooks/useSoundEffects'
import InputHint from './InputHint'
import { useI18n } from '../hooks/i18n'
export default function ConsoleModal({ title, children, onClose, busy = false, kind }) {
  const ref = useRef(null),
    { t } = useI18n()
  const focusedOptionIndex = useRef(0)
  const rememberedIndex = useRef(0)
  const focusOption = useCallback((index, sound = false) => {
    const dialog = ref.current
    const options = Array.from(dialog?.querySelectorAll('[data-game-option]:not(:disabled)') || [])
    if (!options.length) return
    const next = Math.max(0, Math.min(options.length - 1, index))
    if (sound && next !== focusedOptionIndex.current) emitSound('navigate')
    focusedOptionIndex.current = next
    dialog.dataset.focusedOptionIndex = String(next)
    options.forEach((option, i) => {
      option.dataset.controllerFocused = String(i === next)
    })
    options[next].focus({ preventScroll: true })
  }, [])
  useLayoutEffect(() => {
    const previous = document.activeElement,
      dialog = ref.current
    dialog.showModal()
    const initial =
      dialog.querySelector('[data-initial-focus]:not(:disabled)') ||
      dialog.querySelector(
        '[data-modal-content] button:not(:disabled),[data-modal-content] input'
      ) ||
      dialog.querySelector('button')
    focusedOptionIndex.current = 0
    rememberedIndex.current = 0
    if (kind === 'options') focusOption(0)
    else {
      initial?.focus()
      // Native dialog autofocus may precede React focus events (especially on window restore).
      if (initial) initial.dataset.controllerFocused = 'true'
    }
    // Reassert after native dialog autofocus and any parent passive effects.
    let frame = requestAnimationFrame(() => {
      if (kind === 'options') focusOption(focusedOptionIndex.current)
    })
    const regainFocus = () => {
      if (kind !== 'options') return
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => focusOption(focusedOptionIndex.current))
    }
    window.addEventListener('focus', regainFocus)
    const observer = new MutationObserver(() => {
      if (document.activeElement?.hasAttribute('data-modal-close'))
        dialog.querySelector('[data-modal-content] button:not(:disabled)')?.focus()
    })
    observer.observe(dialog, { childList: true, subtree: true })
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('focus', regainFocus)
      observer.disconnect()
      dialog.close()
      previous?.focus({ preventScroll: true })
    }
  }, [kind, focusOption])
  useEffect(() => {
    const dialog = ref.current
    const input = ({ detail }) => {
      const listening = dialog.querySelector('[data-hotkey-listening]')
      if (listening) {
        listening.dispatchEvent(new CustomEvent('controller-hotkey', { detail }))
        return
      }
      const dropdown = dialog.querySelector('[data-dropdown-open]')
      if (dropdown) {
        dropdown.dispatchEvent(new CustomEvent('controller-dropdown', { detail }))
        return
      }
      const { hit, move, axes, now } = detail
      const browser = dialog.querySelector('[data-core-browser]')
      if (
        browser &&
        !busy &&
        (hit(2) || (hit(0) && document.activeElement?.matches('[data-core-search]')))
      ) {
        browser.dispatchEvent(new CustomEvent('controller-core-search', { detail }))
        return
      }
      if (hit(1) && !busy) {
        onClose()
        return
      }
      if (kind === 'options') {
        // Controller selection is independent of document.activeElement: a lost
        // DOM focus must neither reset the index nor disable A/B navigation.
        if (move === 'up' || move === 'down') {
          focusOption(focusedOptionIndex.current + (move === 'down' ? 1 : -1), true)
        } else if (hit(0)) {
          focusOption(focusedOptionIndex.current)
          dialog
            .querySelectorAll('[data-game-option]:not(:disabled)')
            [focusedOptionIndex.current]?.click()
        } else if (
          (!detail.inputMode || detail.inputMode === 'gamepad') &&
          !document.activeElement?.matches('[data-game-option]')
        ) {
          focusOption(focusedOptionIndex.current)
        }
        return
      }
      const controls = Array.from(
        dialog.querySelectorAll('button:not(:disabled),select,input')
      ).filter((el) => !el.closest('[hidden]'))
      if (['filter', 'settings'].includes(kind)) {
        const items = controls.filter((el) => !el.hasAttribute('data-modal-close'))
        const index = items.indexOf(document.activeElement)
        if (index >= 0) rememberedIndex.current = index
        else if (detail.inputMode !== 'keyboard')
          items[Math.min(rememberedIndex.current, items.length - 1)]?.focus({ preventScroll: true })
        dialog.dataset.focusedIndex = String(rememberedIndex.current)
      }
      if (move && controls.length) {
        const grid = dialog.querySelector('[data-navigation-grid]')
        const items = grid
          ? Array.from(grid.querySelectorAll('button:not(:disabled)'))
          : controls.filter((el) => !el.hasAttribute('data-modal-close'))
        const index = items.includes(document.activeElement)
          ? items.indexOf(document.activeElement)
          : Math.min(rememberedIndex.current, items.length - 1)
        const columns = grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : 1
        let target = index
        if (move === 'up') target = index >= columns ? index - columns : index
        if (
          move === 'down' &&
          Math.floor(index / columns) < Math.floor((items.length - 1) / columns)
        )
          target = Math.min(items.length - 1, index + columns)
        if (move === 'left')
          target = columns === 1 || index % columns > 0 ? Math.max(0, index - 1) : index
        if (move === 'right')
          target =
            columns === 1 || index % columns < columns - 1
              ? Math.min(items.length - 1, index + 1)
              : index
        rememberedIndex.current = target
        const next = items[target]
        if (next && next !== document.activeElement) emitSound('navigate')
        next?.focus({ preventScroll: true })
        next?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      }
      if (hit(0)) controls.find((el) => el === document.activeElement)?.click()
      if (axes[3] && now - (dialog.scrollAt || 0) > 100) {
        dialog.scrollBy({ top: axes[3] * 90, behavior: 'smooth' })
        dialog.scrollAt = now
      }
    }
    dialog.addEventListener('controller-input', input)
    return () => dialog.removeEventListener('controller-input', input)
  })
  return (
    <dialog
      ref={ref}
      data-console-modal={kind}
      aria-labelledby="console-modal-title"
      className="console-modal"
      onCancel={(e) => {
        e.preventDefault()
        if (!busy) onClose()
      }}
      onFocusCapture={(e) => {
        const controls = Array.from(
          ref.current.querySelectorAll(
            '[data-modal-content] button:not(:disabled),[data-modal-content] select,[data-modal-content] input'
          )
        )
        const selected = controls.indexOf(e.target)
        if (selected >= 0) rememberedIndex.current = selected
        controls.forEach((el) => (el.dataset.controllerFocused = String(el === e.target)))
        if (kind !== 'options' || !e.target.matches('[data-game-option]')) return
        const options = Array.from(ref.current.querySelectorAll('[data-game-option]'))
        const index = options.indexOf(e.target)
        focusedOptionIndex.current = index
        ref.current.dataset.focusedOptionIndex = String(index)
        options.forEach((option, i) => {
          option.dataset.controllerFocused = String(i === index)
        })
      }}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (kind === 'options' && ['ArrowUp', 'ArrowDown'].includes(e.key)) {
          e.preventDefault()
          focusOption(focusedOptionIndex.current + (e.key === 'ArrowDown' ? 1 : -1), true)
        }
      }}
    >
      <header className="mb-6 flex items-center justify-between gap-5">
        <h2 id="console-modal-title" className="text-2xl font-bold">
          {title}
        </h2>
        <button data-modal-close disabled={busy} onClick={onClose}>
          <InputHint keyboard="Esc" gamepad="B">
            {t('close')}
          </InputHint>
        </button>
      </header>
      <div data-modal-content>{children}</div>
    </dialog>
  )
}
