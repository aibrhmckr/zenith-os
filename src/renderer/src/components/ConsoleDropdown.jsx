/* eslint-disable react/prop-types -- Internal accessible controller dropdown. */
import { emitSound } from '../hooks/useSoundEffects'
import { useEffect, useRef, useState } from 'react'

/**
 * Provide a controlled accessible listbox with independent open/highlight state. Commit through
 * onChange only after A/Enter or a pointer selection.
 *
 * @param {Object} options - Named inputs for this operation.
 * @param {string} options.label - Accessible control label.
 * @param {*} options.value - Input value being normalized, displayed, or committed by this helper.
 * @param {Object} options.options - Operation configuration; see destructured properties and defaults below.
 * @param {Function} options.onChange - Commit the controlled value/text to the parent.
 */
export default function ConsoleDropdown({ label, value, options, onChange }) {
  /**
   * Listbox event root and trigger focus target for cancellation or a committed selection.
   */
  const root = useRef(null),
    trigger = useRef(null)
  /**
   * Controls whether parent modal input is delegated to this dropdown.
   */
  const [open, setOpen] = useState(false)
  /**
   * Highlighted option is separate from the controlled committed value.
   */
  const [index, setIndex] = useState(0)
  /**
   * Dismiss the list without committing a new value and return focus to its trigger.
   */
  const close = () => {
    setOpen(false)
    trigger.current?.focus({ preventScroll: true })
  }
  /**
   * Commit the highlighted option, play toggle feedback, and return focus to the closed trigger.
   *
   * @param {number} i - Zero-based option index.
   */
  const choose = (i) => {
    emitSound('toggle')
    onChange(options[i].value)
    close()
  }
  /**
   * Open at the current value so reopening does not unexpectedly select the first language.
   */
  const show = () => {
    emitSound('toggle')
    setIndex(
      Math.max(
        0,
        options.findIndex(
          /**
           * Locate the matching options entry by index so show can maintain selection without retaining a stale DOM reference.
           *
           * @param {*} option - Value supplied by the enclosing operation; interpreted in this callback's local scope.
           */
          (option) => option.value === value
        )
      )
    )
    setOpen(true)
  }
  /**
   * Clamp the highlighted index to the available options; dropdown navigation never wraps.
   *
   * @param {number} step - Signed relative movement, normally -1 or +1.
   */
  const move = (step) =>
    setIndex(
      /**
       * Compute move's next React state from the latest queued value, avoiding stale render snapshots.
       *
       * @param {*} current - Latest queued state or collection entry.
       */
      (current) => Math.max(0, Math.min(options.length - 1, current + step))
    )
  /**
   * Focus the highlighted option when opening or moving within the list.
   */
  useEffect(() => {
    if (open) {
      emitSound('navigate')
      root.current?.querySelector(`[data-option-index="${index}"]`)?.focus({ preventScroll: true })
    }
  }, [open, index])
  /**
   * Listen only for parent-routed dropdown frames; cleanup avoids duplicate A/B handling.
   */
  useEffect(() => {
    const element = root.current
    /**
     * Consume dropdown-local B, up/down, and A input while the parent modal suspends its own
     * navigation.
     *
     * @param {Object} options - Named inputs for this operation.
     * @param {Object} options.detail - Named inputs for this operation.
     * @param {Function} options.detail.hit - True only for a newly pressed button index.
     * @param {string} options.detail.move - Throttled navigation direction, or null on frames without movement.
     */
    const controller = ({ detail: { hit, move: direction } }) => {
      if (hit(1)) {
        close()
        return
      }
      if (direction === 'down' || direction === 'up') move(direction === 'down' ? 1 : -1)
      else if (hit(0)) choose(index)
    }
    element.addEventListener('controller-dropdown', controller)
    /**
     * Release the listeners, timers, or focus ownership acquired by ConsoleDropdown's effect before it reruns or unmounts.
     */
    return () => element.removeEventListener('controller-dropdown', controller)
  })
  return (
    <div
      ref={root}
      data-dropdown-open={open ? '' : undefined}
      className="console-dropdown"
      onBlur={
        /**
         * Handle onBlur on this ConsoleDropdown control using the current render's values; delegate state/IPC work to its owning component.
         *
         * @param {*} event - DOM/Electron event supplied by the subscription.
         */
        (event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
        }
      }
      onKeyDown={
        /**
         * Handle onKeyDown on this ConsoleDropdown control using the current render's values; delegate state/IPC work to its owning component.
         *
         * @param {*} event - DOM/Electron event supplied by the subscription.
         */
        (event) => {
          if (!open && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
            event.preventDefault()
            show()
            return
          }
          if (!open) return
          if (['Escape', 'ArrowUp', 'ArrowDown', 'Enter', ' '].includes(event.key)) {
            event.preventDefault()
            event.stopPropagation()
            if (event.key === 'Escape') close()
            else if (event.key === 'ArrowUp' || event.key === 'ArrowDown')
              move(event.key === 'ArrowDown' ? 1 : -1)
            else choose(index)
          }
        }
      }
    >
      <button
        ref={trigger}
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-controls="language-options"
        aria-haspopup="listbox"
        className="console-button language-trigger w-full flex items-center justify-between px-4 py-2.5"
        onClick={
          /**
           * Handle onClick on this ConsoleDropdown control using the current render's values; delegate state/IPC work to its owning component.
           */
          () => (open ? close() : show())
        }
      >
        {
          options.find(
            /**
             * Select the first matching options entry for ConsoleDropdown; absence is handled by the caller's fallback.
             *
             * @param {*} option - Value supplied by the enclosing operation; interpreted in this callback's local scope.
             */
            (option) => option.value === value
          )?.label
        }
        <span aria-hidden="true">⌄</span>
      </button>
      {open && (
        <div
          id="language-options"
          role="listbox"
          aria-label={label}
          className="console-dropdown-list"
        >
          {options.map(
            /**
             * Project each options entry for ConsoleDropdown; preserve input ordering in the derived collection.
             *
             * @param {*} option - Value supplied by the enclosing operation; interpreted in this callback's local scope.
             * @param {*} i - Zero-based collection index.
             */
            (option, i) => (
              <button
                key={option.value}
                role="option"
                aria-selected={value === option.value}
                data-option-index={i}
                tabIndex={i === index ? 0 : -1}
                onClick={
                  /**
                   * Handle onClick on this ConsoleDropdown control using the current render's values; delegate state/IPC work to its owning component.
                   */
                  () => choose(i)
                }
                className="console-dropdown-option"
              >
                {option.label}
                <span aria-hidden="true">{option.value === value ? '✓' : ''}</span>
              </button>
            )
          )}
        </div>
      )}
    </div>
  )
}
