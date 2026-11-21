import { expect, test } from 'vitest'
import { orderPlugins, StartError, type WonderRoomPlugin } from '../src'

const plugin = (name: string, requires?: string[]): WonderRoomPlugin => ({ name, kind: 'add-on', requires })
const names = (plugins: WonderRoomPlugin[]) => plugins.map((p) => p.name)

test('puts each plugin after what it requires', () => {
  const ordered = orderPlugins([plugin('twdb', ['typewriters', 'makers']), plugin('typewriters', ['makers']), plugin('makers')])
  expect(names(ordered)).toEqual(['makers', 'typewriters', 'twdb'])
})

test('keeps input order otherwise', () => {
  expect(names(orderPlugins([plugin('b'), plugin('a'), plugin('c')]))).toEqual(['b', 'a', 'c'])
})

test('missing requirement', () => {
  expect(() => orderPlugins([plugin('twdb', ['makers'])])).toThrow(
    new StartError('twdb requires makers, but plugins.yml does not list makers.'),
  )
})

test('loop', () => {
  expect(() => orderPlugins([plugin('a', ['b']), plugin('b', ['a'])])).toThrow(
    new StartError('These plugins require each other in a loop: a → b → a.'),
  )
})

test('duplicate name', () => {
  expect(() => orderPlugins([plugin('curios'), plugin('curios')])).toThrow(
    new StartError('plugins.yml lists curios twice.'),
  )
})
