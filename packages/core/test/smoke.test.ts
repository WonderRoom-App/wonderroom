import { expect, test } from 'vitest'
import * as core from '../src'

test('core module loads', () => {
  expect(typeof core).toBe('object')
})
