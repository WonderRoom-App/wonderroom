import { expect, test } from 'vitest'
import { definePlugin, StartError } from '../src'

const itemType = { slug: 'x', labels: { singular: 'X', plural: 'Xs' }, fields: [] }

test('returns a valid plugin unchanged', () => {
  const plugin = { name: 'a', kind: 'add-on' as const }
  expect(definePlugin(plugin)).toBe(plugin)
  const typed = { name: 'b', kind: 'item-type' as const, itemType }
  expect(definePlugin(typed)).toBe(typed)
})

test('rejects bad plugins with StartError', () => {
  const bad = [
    { name: '', kind: 'add-on' },
    { name: 'a', kind: 'bogus' },
    { name: 'a', kind: 'item-type' },
    { name: 'a', kind: 'add-on', itemType },
  ]
  for (const plugin of bad) {
    expect(() => definePlugin(plugin as never)).toThrow(StartError)
  }
})
