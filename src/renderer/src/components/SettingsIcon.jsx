/* eslint-disable react/prop-types -- Decorative navigation icons. */
/** Small original vectors keep settings navigation legible without text-only arrows. */
export default function SettingsIcon({ name }) {
  const paths = {
    palette: (
      <>
        <path d="M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 1.3-3.5 1.5 1.5 0 0 1 1-2.5H18c4 0 4-12-6-12Z" />
        <circle cx="7" cy="10" r=".7" />
        <circle cx="10" cy="7" r=".7" />
        <circle cx="14" cy="7" r=".7" />
        <circle cx="17" cy="10" r=".7" />
      </>
    ),
    chip: (
      <>
        <rect x="6" y="6" width="12" height="12" rx="3" />
        <rect x="9" y="9" width="6" height="6" rx="1" />
        <path d="M9 3v3m6-3v3M9 18v3m6-3v3M3 9h3m-3 6h3m12-6h3m-3 6h3" />
      </>
    ),
    update: (
      <>
        <path d="M20 10a8 8 0 0 0-14-4L3 9m0-6v6h6m-5 5a8 8 0 0 0 14 4l3-3m0 6v-6h-6" />
      </>
    ),
    globe: (
      <>
        <circle cx="12" cy="12" r="9" />
        <ellipse cx="12" cy="12" rx="4" ry="9" />
        <path d="M3 12h18M5 6.5h14M5 17.5h14" />
      </>
    ),
    back: <path d="m10 5-7 7 7 7M3 12h18" />,
    settings: (
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1Z" />
      </>
    ),
    book: (
      <>
        <path d="M12 5v16M12 5C8 2 4 3 2 4v15c4-2 7-1 10 2 3-3 6-4 10-2V4c-2-1-6-2-10 1Z" />
      </>
    ),
    gamepad: (
      <>
        <path d="M7 6h10c3 0 4 4 5 11 0 3-3 3-5 0H7c-2 3-5 3-5 0 1-7 2-11 5-11Z M5 11h6m-3-3v6m8-4h1m2 3h1" />
      </>
    ),
    trash: <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7" />,
    play: <path d="m7 3 14 9-14 9Z" />,
    stop: <rect x="5" y="5" width="14" height="14" rx="2" />,
    power: (
      <>
        <path d="M12 2v10m-5-7a9 9 0 1 0 10 0" />
      </>
    ),
    bell: <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />,
    chevron: <path d="m9 5 7 7-7 7" />
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
      focusable="false"
    >
      {paths[name]}
    </svg>
  )
}
