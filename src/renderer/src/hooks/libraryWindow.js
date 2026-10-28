/** Render visible/nearby rows plus the focus target. Indices remain global for controller navigation. */
export function libraryWindow(total, columns, focusedIndex, scrollRow = 0) {
  if (total <= 96) return Array.from({ length: total }, (_, index) => index)
  const rows = new Set()
  for (const center of [scrollRow, Math.floor(focusedIndex / columns)])
    for (let row = Math.max(0, center - 2); row <= center + 4; row++) rows.add(row)
  return [...rows]
    .sort((a, b) => a - b)
    .flatMap((row) =>
      Array.from({ length: columns }, (_, col) => row * columns + col).filter(
        (index) => index < total
      )
    )
}
