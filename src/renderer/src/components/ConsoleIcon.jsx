/* eslint-disable react/prop-types -- Decorative console silhouettes shared by cards. */
/** Original vector hardware silhouettes; no external logo files or network requests. */
export default function ConsoleIcon({ platform }) {
  const shapes = {
    ALL: (
      <>
        <path d="M14 16l2-8c1-3 3-4 6-4h14c3 0 5 2 6 5l3 10c1 4-3 6-6 3l-3-3M21 10h6m-3-3v6m13-3h1" />
        <path d="M12 20h19c4 0 6 4 7 8l3 10c1 5-4 7-7 4l-5-5H16l-5 5c-3 3-8 1-7-4l3-10c1-4 2-8 5-8Z" />
        <path d="M12 25h8m-4-4v8m16-5h1m3 5h1" />
      </>
    ),
    PS2: (
      <>
        <path d="M13 5h21v38H13zM9 43h29M18 5v38M22 13h8m-8 5h8m-8 16h8m-8 4h8" />
      </>
    ),
    PS3: (
      <>
        <path d="M10 9c9-5 23-4 28 2v26c-5 6-29 6-30 0V13l2-4Z" />
        <path d="M13 11v26m6-21h14m-14 4h14m-4 13h4" />
      </>
    ),
    PSP: (
      <>
        <rect x="3" y="12" width="42" height="25" rx="10" />
        <rect x="14" y="17" width="20" height="15" rx="2" />
        <path d="M6 24h6m-3-3v6m29-5h1m2 5h1" />
      </>
    ),
    NDS: (
      <>
        <rect x="8" y="3" width="32" height="19" rx="3" />
        <rect x="6" y="25" width="36" height="20" rx="4" />
        <rect x="13" y="7" width="22" height="11" rx="1" />
        <rect x="16" y="29" width="17" height="12" rx="1" />
        <path d="M8 34h6m-3-3v6m26-6v2m0 4v2M11 22v3m26-3v3" />
      </>
    ),
    'Atari 2600': (
      <>
        <path d="M8 21h32l5 18H3zM5 33h38M11 25h26m-24 4h22M24 21V7m-7 14V9m14 12V9" />
        <circle cx="24" cy="6" r="3" />
      </>
    )
  }
  const handheld = ['GBA', 'GBC', '3DS', 'Atari Lynx'].includes(platform)
  const disc = ['PS1', 'GameCube', 'Wii', 'Dreamcast'].includes(platform)
  return (
    <svg
      viewBox="0 0 48 48"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      data-console-icon={platform}
    >
      {shapes[platform] ||
        (handheld ? (
          <>
            <rect x="3" y="11" width="42" height="26" rx="6" />
            <rect x="14" y="16" width="20" height="16" rx="2" />
            <path d="M6 24h6m-3-3v6m29-5h1m2 5h1" />
          </>
        ) : disc ? (
          <>
            <rect x="5" y="9" width="38" height="30" rx="5" />
            <circle cx="24" cy="23" r="9" />
            <circle cx="24" cy="23" r="2" />
            <path d="M11 34h8m15 0h3" />
          </>
        ) : (
          <>
            <rect x="5" y="15" width="38" height="24" rx="5" />
            <path d="M15 15V9h18v6m-19 9v8m-4-4h8m14-3h1m3 6h1" />
          </>
        ))}
    </svg>
  )
}
