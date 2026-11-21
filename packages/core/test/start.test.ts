import { afterEach, describe, expect, test } from 'vitest'
import { expectExit, stopStarts, withInstall } from './helpers/install'

afterEach(stopStarts)

const needs = (name: string, ...requires: string[]) => ({ use: 'toy-needs', name, requires })

describe('plugin requirements at start', { timeout: 120_000 }, () => {
  test('a plugin that requires an unlisted plugin stops the start', () =>
    withInstall(async (install) => {
      install.plugins([needs('a', 'b')])
      const stopped = await install.start()
      expectExit(stopped, 1)
      expect(stopped.output).toContain('a requires b, but plugins.yml does not list b.')
    }))

  test('plugins that require each other stop the start', () =>
    withInstall(async (install) => {
      install.plugins([needs('a', 'b'), needs('b', 'a')])
      const stopped = await install.start()
      expectExit(stopped, 1)
      expect(stopped.output).toContain('These plugins require each other in a loop: a → b → a.')
    }))
})
