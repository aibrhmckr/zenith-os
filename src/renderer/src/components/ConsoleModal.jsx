/* eslint-disable react/prop-types -- Internal modal shared by console panels. */
import { useEffect, useLayoutEffect, useRef, useCallback } from 'react'
import { emitSound } from '../hooks/useSoundEffects'
import InputHint from './InputHint'
import { useI18n } from '../hooks/i18n'
/**
 * Render a native modal dialog with controller focus ownership. Options use an explicit
 * selection index; filters use measured grid columns and Settings uses a vertical list.
 *
 * @param {Object} options - Named inputs for this operation.
 * @param {string} options.title - Display title or cleaned game title to match.
 * @param {import("react").ReactNode} options.children - Nested content rendered within the provider, dialog, or hint.
 * @param {Function} options.onClose - Ask the owner to dismiss this surface and restore its prior focus.
 * @param {boolean} options.busy - Disable actions while the parent operation is pending.
 * @param {string} options.kind - Media category or modal type selecting this operation's behavior.
 */
export default function ConsoleModal({ title, children, onClose, busy = false, kind }) {
  /**
   * Native dialog ref; its modal top layer traps browser focus independently of React state.
   */
  const ref = useRef(null),
    { t } = useI18n()
  /**
   * Explicit Game Options/session selection survives DOM blur; never infer controller selection
   * exclusively from activeElement.
   */
  const focusedOptionIndex = useRef(0)
  /**
   * Remember the last settings/filter item so focus loss cannot route input to the background.
   */
  const rememberedIndex = useRef(0)
  /**
   * Clamp and remember the enabled Game Options selection, synchronize the blue focus marker, and
   * focus it without moving the page.
   *
   * @param {number} index - Zero-based selection, button, or page index.
   * @param {boolean} sound - Enable preview audio or focus-change feedback; visual playback remains independently gated.
   */
  const focusOption = useCallback((index, sound = false) => {
    const dialog = ref.current
    const options = Array.from(
      dialog?.querySelectorAll(':is([data-game-option],[data-session-option]):not(:disabled)') || []
    )
    if (!options.length) return
    const next = Math.max(0, Math.min(options.length - 1, index))
    if (sound && next !== focusedOptionIndex.current) emitSound('navigate')
    focusedOptionIndex.current = next
    dialog.dataset.focusedOptionIndex = String(next)
    options.forEach(
      /**
       * Apply focusOption's per-entry side effect to options; this callback does not build a result collection.
       *
       * @param {*} option - Value supplied by the enclosing operation; interpreted in this callback's local scope.
       * @param {*} i - Zero-based collection index.
       */
      (option, i) => {
        option.dataset.controllerFocused = String(i === next)
      }
    )
    options[next].focus({ preventScroll: true })
  }, [])
  /**
   * Open the native dialog, force the initial controller target, repair option focus on window
   * return, and restore prior focus on cleanup.
   */
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
    if (['options', 'session'].includes(kind)) focusOption(0)
    else {
      initial?.focus()
      // Native dialog autofocus may precede React focus events (especially on window restore).
      if (initial) initial.dataset.controllerFocused = 'true'
    }
    // Reassert after native dialog autofocus and any parent passive effects.
    let frame = requestAnimationFrame(
      /**
       * Synchronize frame's focus/animation work with the next frame rather than an intermediate DOM state.
       */
      () => {
        if (['options', 'session'].includes(kind)) focusOption(focusedOptionIndex.current)
      }
    )
    /**
     * Reassert the remembered Game Options button on the next frame after window focus returns.
     */
    const regainFocus = () => {
      if (!['options', 'session'].includes(kind)) return
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(
        /**
         * Synchronize regainFocus's focus/animation work with the next frame rather than an intermediate DOM state.
         */
        () => focusOption(focusedOptionIndex.current)
      )
    }
    window.addEventListener('focus', regainFocus)
    const observer = new MutationObserver(
      /**
       * React to MutationObserver changes within observer; its owner disconnects the observer during cleanup.
       */
      () => {
        if (document.activeElement?.hasAttribute('data-modal-close'))
          dialog.querySelector('[data-modal-content] button:not(:disabled)')?.focus()
      }
    )
    observer.observe(dialog, { childList: true, subtree: true })
    /**
     * Release the listeners, timers, or focus ownership acquired by ConsoleModal's effect before it reruns or unmounts.
     */
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('focus', regainFocus)
      observer.disconnect()
      dialog.close()
      previous?.focus({ preventScroll: true })
    }
  }, [kind, focusOption])
  /**
   * Route each frame exclusively within this dialog; unregister the handler before its captured
   * props become stale.
   */
  useEffect(() => {
    const dialog = ref.current
    /**
     * Route controller frames first to a listening hotkey editor, open dropdown, or core search.
     * Otherwise handle B/A, bounded grid movement, and right-stick scrolling without leaking input.
     *
     * @param {Object} options - Named inputs for this operation.
     * @param {Object} options.detail - CustomEvent payload carrying controller frame data.
     */
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
      if (['options', 'session'].includes(kind)) {
        // Controller selection is independent of document.activeElement: a lost
        // DOM focus must neither reset the index nor disable A/B navigation.
        if (move === 'up' || move === 'down') {
          focusOption(focusedOptionIndex.current + (move === 'down' ? 1 : -1), true)
        } else if (hit(0)) {
          focusOption(focusedOptionIndex.current)
          dialog
            .querySelectorAll(':is([data-game-option],[data-session-option]):not(:disabled)')
            [focusedOptionIndex.current]?.click()
        } else if (
          (!detail.inputMode || detail.inputMode === 'gamepad') &&
          !document.activeElement?.matches(':is([data-game-option],[data-session-option])')
        ) {
          focusOption(focusedOptionIndex.current)
        }
        return
      }
      const controls = Array.from(
        dialog.querySelectorAll('button:not(:disabled),select,input')
      ).filter(
        /**
         * Retain only Array.from( dialog.querySelectorAll('button:not(:disabled),select,input') ) entries satisfying controls's local predicate; excluded values do not reach the next stage.
         *
         * @param {*} el - Value supplied by the enclosing operation; interpreted in this callback's local scope.
         */
        (el) => !el.closest('[hidden]')
      )
      if (['filter', 'settings'].includes(kind)) {
        const items = controls.filter(
          /**
           * Retain only controls entries satisfying items's local predicate; excluded values do not reach the next stage.
           *
           * @param {*} el - Value supplied by the enclosing operation; interpreted in this callback's local scope.
           */
          (el) => !el.hasAttribute('data-modal-close')
        )
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
          : controls.filter(
              /**
               * Retain only controls entries satisfying items's local predicate; excluded values do not reach the next stage.
               *
               * @param {*} el - Value supplied by the enclosing operation; interpreted in this callback's local scope.
               */
              (el) => !el.hasAttribute('data-modal-close')
            )
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
      if (hit(0))
        controls
          .find(
            /**
             * Select the first matching controls entry for input; absence is handled by the caller's fallback.
             *
             * @param {*} el - Value supplied by the enclosing operation; interpreted in this callback's local scope.
             */
            (el) => el === document.activeElement
          )
          ?.click()
      if (axes[3] && now - (dialog.scrollAt || 0) > 100) {
        dialog.scrollBy({ top: axes[3] * 90, behavior: 'smooth' })
        dialog.scrollAt = now
      }
    }
    dialog.addEventListener('controller-input', input)
    /**
     * Release the listeners, timers, or focus ownership acquired by ConsoleModal's effect before it reruns or unmounts.
     */
    return () => dialog.removeEventListener('controller-input', input)
  })
  return (
    <dialog
      ref={ref}
      data-console-modal={kind}
      aria-labelledby="console-modal-title"
      className="console-modal"
      onCancel={
        /**
         * Handle onCancel on this ConsoleModal control using the current render's values; delegate state/IPC work to its owning component.
         *
         * @param {*} e - DOM event from this control.
         */
        (e) => {
          e.preventDefault()
          if (!busy) onClose()
        }
      }
      onFocusCapture={
        /**
         * Handle onFocusCapture on this ConsoleModal control using the current render's values; delegate state/IPC work to its owning component.
         *
         * @param {*} e - DOM event from this control.
         */
        (e) => {
          const controls = Array.from(
            ref.current.querySelectorAll(
              '[data-modal-content] button:not(:disabled),[data-modal-content] select,[data-modal-content] input'
            )
          )
          const selected = controls.indexOf(e.target)
          if (selected >= 0) rememberedIndex.current = selected
          controls.forEach(
            /**
             * Apply ConsoleModal's per-entry side effect to controls; this callback does not build a result collection.
             *
             * @param {*} el - Value supplied by the enclosing operation; interpreted in this callback's local scope.
             */
            (el) => (el.dataset.controllerFocused = String(el === e.target))
          )
          if (
            !['options', 'session'].includes(kind) ||
            !e.target.matches(':is([data-game-option],[data-session-option])')
          )
            return
          const options = Array.from(
            ref.current.querySelectorAll(':is([data-game-option],[data-session-option])')
          )
          const index = options.indexOf(e.target)
          focusedOptionIndex.current = index
          ref.current.dataset.focusedOptionIndex = String(index)
          options.forEach(
            /**
             * Apply ConsoleModal's per-entry side effect to options; this callback does not build a result collection.
             *
             * @param {*} option - Value supplied by the enclosing operation; interpreted in this callback's local scope.
             * @param {*} i - Zero-based collection index.
             */
            (option, i) => {
              option.dataset.controllerFocused = String(i === index)
            }
          )
        }
      }
      onKeyDown={
        /**
         * Handle onKeyDown on this ConsoleModal control using the current render's values; delegate state/IPC work to its owning component.
         *
         * @param {*} e - DOM event from this control.
         */
        (e) => {
          e.stopPropagation()
          if (['options', 'session'].includes(kind) && ['ArrowUp', 'ArrowDown'].includes(e.key)) {
            e.preventDefault()
            focusOption(focusedOptionIndex.current + (e.key === 'ArrowDown' ? 1 : -1), true)
          }
        }
      }
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
