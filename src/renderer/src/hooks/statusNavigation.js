/**
 * Pick a status control without invoking it. Cards are in row-major order and
 * contain visible, enabled controls with { id, rect, details }. Measured rows
 * preserve console-specific action grids; card boundaries use the outer grid.
 */
export function statusFocusTarget(cards, currentId, direction, columns = 2) {
  const cardIndex = cards.findIndex((card) => card.some((item) => item.id === currentId))
  if (cardIndex < 0) return cards.flat()[0]?.id ?? currentId
  const items = cards[cardIndex]
  const current = items.find((item) => item.id === currentId)
  const actions = items.filter((item) => !item.details)
  const details = items.find((item) => item.details)
  const centerX = (item) => item.rect.left + item.rect.width / 2
  const centerY = (item) => item.rect.top + item.rect.height / 2
  const nearest = (candidates, score) => [...candidates].sort((a, b) => score(a) - score(b))[0]
  let target = current
  if (direction === 'left' || direction === 'right') {
    const sign = direction === 'right' ? 1 : -1
    const withinRow =
      !current.details &&
      nearest(
        actions.filter(
          (item) =>
            Math.abs(centerY(item) - centerY(current)) < 8 &&
            (centerX(item) - centerX(current)) * sign > 4
        ),
        (item) => Math.abs(centerX(item) - centerX(current))
      )
    if (withinRow) target = withinRow
    else {
      const neighborIndex = cardIndex + sign
      const sameRow =
        neighborIndex >= 0 &&
        Math.floor(neighborIndex / columns) === Math.floor(cardIndex / columns)
      const neighbor = sameRow ? cards[neighborIndex] : null
      if (neighbor) {
        target =
          (current.details
            ? neighbor.find((item) => item.details)
            : nearest(
                neighbor.filter((item) => !item.details),
                (item) =>
                  Math.abs(centerY(item) - centerY(current)) * 1000 +
                  Math.abs(centerX(item) - centerX(current))
              )) ||
          neighbor[0] ||
          current
      }
    }
  } else if (direction === 'down') {
    if (current.details) target = cards[cardIndex + columns]?.[0] || current
    else
      target =
        nearest(
          actions.filter((item) => item.rect.top > current.rect.top + 8),
          (item) =>
            (item.rect.top - current.rect.top) * 1000 + Math.abs(centerX(item) - centerX(current))
        ) ||
        details ||
        current
  } else if (direction === 'up') {
    target =
      nearest(
        actions.filter((item) => item.rect.top < current.rect.top - 8),
        (item) =>
          (current.rect.top - item.rect.top) * 1000 + Math.abs(centerX(item) - centerX(current))
      ) ||
      cards[cardIndex - columns]?.at(-1) ||
      current
  }
  return target.id
}
