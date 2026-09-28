/* eslint-disable react/prop-types -- Internal accessible controller dropdown. */
import { emitSound } from '../hooks/useSoundEffects'
import { useEffect, useRef, useState } from 'react'

export default function ConsoleDropdown({ label, value, options, onChange }) {
  const root = useRef(null),
    trigger = useRef(null)
  const [open, setOpen] = useState(false)
  const [index, setIndex] = useState(0)
  const close = () => {
    setOpen(false)
    trigger.current?.focus({ preventScroll: true })
  }
  const choose = (i) => {
    emitSound('toggle')
    onChange(options[i].value)
    close()
  }
  const show = () => {
    emitSound('toggle')
    setIndex(
      Math.max(
        0,
        options.findIndex((option) => option.value === value)
      )
    )
    setOpen(true)
  }
  const move = (step) =>
    setIndex((current) => Math.max(0, Math.min(options.length - 1, current + step)))
  useEffect(() => {
    if (open) {
      emitSound('navigate')
      root.current?.querySelector(`[data-option-index="${index}"]`)?.focus({ preventScroll: true })
    }
  }, [open, index])
  useEffect(() => {
    const element = root.current
    const controller = ({ detail: { hit, move: direction } }) => {
      if (hit(1)) {
        close()
        return
      }
      if (direction === 'down' || direction === 'up') move(direction === 'down' ? 1 : -1)
      else if (hit(0)) choose(index)
    }
    element.addEventListener('controller-dropdown', controller)
    return () => element.removeEventListener('controller-dropdown', controller)
  })
  return (
    <div
      ref={root}
      data-dropdown-open={open ? '' : undefined}
      className="console-dropdown"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
      }}
      onKeyDown={(event) => {
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
      }}
    >
      <button
        ref={trigger}
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-controls="language-options"
        aria-haspopup="listbox"
        className="console-button language-trigger w-full flex items-center justify-between px-4 py-2.5"
        onClick={() => (open ? close() : show())}
      >
        {options.find((option) => option.value === value)?.label}
        <span aria-hidden="true">⌄</span>
      </button>
      {open && (
        <div
          id="language-options"
          role="listbox"
          aria-label={label}
          className="console-dropdown-list"
        >
          {options.map((option, i) => (
            <button
              key={option.value}
              role="option"
              aria-selected={value === option.value}
              data-option-index={i}
              tabIndex={i === index ? 0 : -1}
              onClick={() => choose(i)}
              className="console-dropdown-option"
            >
              {option.label}
              <span aria-hidden="true">{option.value === value ? '✓' : ''}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
