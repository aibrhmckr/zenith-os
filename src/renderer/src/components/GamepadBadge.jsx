/* eslint-disable react/prop-types -- Shared controller glyph presentation. */
/** Solid Xbox face buttons and neutral shoulder capsules shared by every surface. */
export default function GamepadBadge({ button }) {
  const tone = ['A', 'B', 'X', 'Y'].includes(button) ? button : 'neutral'
  return (
    <kbd
      data-input-mode="gamepad"
      data-gamepad-badge={button}
      className={`input-badge pad-badge pad-${tone}`}
    >
      {button}
    </kbd>
  )
}
