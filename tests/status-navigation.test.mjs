import test from 'node:test'
import assert from 'node:assert/strict'
import { statusFocusTarget } from '../src/renderer/src/hooks/statusNavigation.js'
import { spotlightMetadata } from '../src/renderer/src/hooks/spotlightMetadata.js'

const item = (id, x, y, details = false) => ({
  id,
  details,
  rect: { left: x, top: y, width: 80, height: 40 }
})
const cards = [
  [
    item('a0', 0, 0),
    item('a1', 100, 0),
    item('a2', 0, 50),
    item('a3', 100, 50),
    item('ad', 0, 120, true)
  ],
  [item('b0', 220, 0), item('b1', 320, 0), item('b2', 220, 50), item('bd', 220, 120, true)],
  [item('c0', 0, 250), item('cd', 0, 370, true)],
  [item('d0', 220, 250), item('dd', 220, 370, true)],
  [item('e0', 0, 500), item('ed', 0, 620, true)]
]

test('status navigation prioritizes local button rows then crosses to the adjacent card', () => {
  for (const [from, direction, to] of [
    ['a0', 'right', 'a1'],
    ['a1', 'right', 'b0'],
    ['b0', 'left', 'a1'],
    ['b1', 'left', 'b0'],
    ['a3', 'right', 'b2'],
    ['b2', 'left', 'a3'],
    ['ad', 'right', 'bd'],
    ['bd', 'left', 'ad'],
    ['a0', 'left', 'a0'],
    ['b1', 'right', 'b1'],
    ['ed', 'right', 'ed'],
    ['c0', 'left', 'c0']
  ])
    assert.equal(statusFocusTarget(cards, from, direction), to, `${from} ${direction}`)
})

test('status vertical movement retains the column and visits Details before leaving a card', () => {
  for (const [from, direction, to] of [
    ['a0', 'down', 'a2'],
    ['a1', 'down', 'a3'],
    ['a3', 'down', 'ad'],
    ['ad', 'down', 'c0'],
    ['c0', 'up', 'ad'],
    ['bd', 'down', 'd0'],
    ['d0', 'up', 'bd'],
    ['a0', 'up', 'a0'],
    ['ed', 'down', 'ed']
  ])
    assert.equal(statusFocusTarget(cards, from, direction), to, `${from} ${direction}`)
})

test('single-column, details-only and missing focus remain bounded', () => {
  assert.equal(statusFocusTarget(cards, 'ad', 'down', 1), 'b0')
  assert.equal(statusFocusTarget(cards, 'ad', 'right', 1), 'ad')
  assert.equal(statusFocusTarget(cards, 'missing', 'down'), 'a0')
  assert.equal(statusFocusTarget([], 'missing', 'down'), 'missing')
  assert.equal(statusFocusTarget([cards[0], [item('bd', 220, 120, true)]], 'a1', 'right'), 'bd')
})

test('spotlight keeps real values when nested metadata is empty and prefers publisher', () => {
  assert.deepEqual(
    spotlightMetadata({
      systemShort: 'PS3',
      year: 2007,
      publisher: 'Example Publisher',
      developer: 'Example Developer',
      metadata: {
        year: null,
        genre: ['Action', '', 'Unknown', 'Adventure'],
        synopsis: 'A journey.'
      }
    }),
    {
      platform: 'PS3',
      year: '2007',
      genre: 'Action, Adventure',
      publisher: 'Example Publisher',
      synopsis: 'A journey.',
      region: 'PAL/NTSC',
      format: 'ISO'
    }
  )
  assert.deepEqual(
    spotlightMetadata({
      platform: 'NDS',
      genre: 'Bilinmiyor',
      description: ' ',
      developer: 'Studio',
      summary: 'Story'
    }),
    {
      platform: 'NDS',
      year: '',
      genre: '',
      publisher: 'Studio',
      synopsis: 'Story',
      region: 'PAL/NTSC',
      format: 'ISO'
    }
  )
})

test('spotlight maps provider aliases, valid dates, region and real ROM extensions', () => {
  const data = spotlightMetadata({
    releaseDate: '2008-07-18',
    genres: ['Action', 'Adventure'],
    overview: 'Overview',
    fileName: 'Game.cso',
    region: 'USA'
  })
  assert.equal(data.year, '2008')
  assert.equal(data.genre, 'Action, Adventure')
  assert.equal(data.synopsis, 'Overview')
  assert.equal(data.format, 'CSO')
  assert.equal(data.region, 'USA')
  assert.equal(
    spotlightMetadata({ releaseDate: 'invalid', plot: 'Plot', category: 'Puzzle' }).year,
    ''
  )
  assert.equal(spotlightMetadata({ plot: 'Plot', category: 'Puzzle' }).synopsis, 'Plot')
  assert.equal(spotlightMetadata({ plot: 'Plot', category: 'Puzzle' }).genre, 'Puzzle')
})
