import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadInstall, type Catalog } from '../src/install'
import { StartError, definePlugin } from '../src/plugin'

function makeConfigDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'wonderroom-'))
  mkdirSync(join(dir, 'config.d'))
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
  return dir
}

const seen: Record<string, unknown>[] = []
const catalog: Catalog = {
  curios: (settings) => {
    seen.push(settings)
    return definePlugin({ name: 'curios', kind: 'add-on' })
  },
}

function messageOf(configDir: string): string {
  try {
    loadInstall(configDir, catalog)
  } catch (error) {
    expect(error).toBeInstanceOf(StartError)
    return (error as Error).message
  }
  throw new Error('loadInstall did not throw')
}

describe('loadInstall', () => {
  it('merges config.d/<use>.yml under the entry keys', () => {
    const dir = makeConfigDir({
      'plugins.yml': 'plugins:\n  - use: curios\n    slug: oddities\n',
      'config.d/curios.yml': 'label: Oddities\nslug: ignored\n',
    })
    const install = loadInstall(dir, catalog)
    expect(seen.at(-1)).toEqual({ slug: 'oddities', label: 'Oddities' })
    expect(install.plugins.map((plugin) => plugin.name)).toEqual(['curios'])
    expect(install.site.name).toBe('WonderRoom')
  })

  it('reads the site name from config.d/site.yml', () => {
    const dir = makeConfigDir({
      'plugins.yml': 'plugins: []\n',
      'config.d/site.yml': 'name: Parlor\n',
    })
    expect(loadInstall(dir, catalog).site.name).toBe('Parlor')
  })

  it('passes confirm lines through unchanged', () => {
    const dir = makeConfigDir({ 'plugins.yml': 'plugins: []\nconfirm:\n  - drop table x\n' })
    expect(loadInstall(dir, catalog).confirm).toEqual(['drop table x'])
  })

  it('lets a StartError from a factory through unchanged', () => {
    const boom = new StartError('boom')
    const dir = makeConfigDir({ 'plugins.yml': 'plugins:\n  - use: curios\n' })
    expect(() => loadInstall(dir, { curios: () => { throw boom } })).toThrow(boom)
  })

  it('names the missing plugins.yml', () => {
    const dir = makeConfigDir({})
    expect(messageOf(dir)).toBe(`No plugins.yml in ${dir}. Create one that lists your plugins.`)
  })

  it('gives the line of invalid YAML', () => {
    const dir = makeConfigDir({ 'plugins.yml': 'plugins:\n  - use: [curios\n' })
    expect(messageOf(dir)).toMatch(/^plugins\.yml line \d+:/)
  })

  it('needs plugins to be a list', () => {
    const dir = makeConfigDir({ 'plugins.yml': 'plugins: curios\n' })
    expect(messageOf(dir)).toBe('plugins.yml: "plugins" must be a list.')
  })

  it('needs every entry to have use', () => {
    const dir = makeConfigDir({ 'plugins.yml': 'plugins:\n  - use: curios\n  - slug: x\n' })
    expect(messageOf(dir)).toBe('plugins.yml entry 2 has no "use".')
  })

  it('names an unknown plugin', () => {
    const dir = makeConfigDir({ 'plugins.yml': 'plugins:\n  - use: coinz\n' })
    expect(messageOf(dir)).toBe('plugins.yml lists "coinz", which is not a known plugin. Known plugins: curios.')
  })

  it('refuses from:', () => {
    const dir = makeConfigDir({ 'plugins.yml': 'plugins:\n  - use: curios\n    from: npm\n' })
    expect(messageOf(dir)).toBe(
      'plugins.yml entry 1 uses "from". Plugins from npm or git come in a later version.',
    )
  })

  it('names a config.d file with bad YAML', () => {
    const dir = makeConfigDir({
      'plugins.yml': 'plugins:\n  - use: curios\n',
      'config.d/curios.yml': 'label: [x\n',
    })
    expect(messageOf(dir)).toMatch(/^config\.d\/curios\.yml line \d+:/)
  })

  it('needs a config.d file to be a mapping', () => {
    const dir = makeConfigDir({
      'plugins.yml': 'plugins:\n  - use: curios\n',
      'config.d/curios.yml': 'hello\n',
    })
    expect(messageOf(dir)).toBe('config.d/curios.yml must be a mapping of settings.')
  })

  it('needs site name to be text', () => {
    const dir = makeConfigDir({ 'plugins.yml': 'plugins: []\n', 'config.d/site.yml': 'name: 5\n' })
    expect(messageOf(dir)).toContain('config.d/site.yml')
  })

  it('needs confirm to be a list of text lines', () => {
    const dir = makeConfigDir({ 'plugins.yml': 'plugins: []\nconfirm: yes please\n' })
    expect(messageOf(dir)).toBe('plugins.yml: "confirm" must be a list of text lines.')
  })

  it('does not treat object keys as plugins', () => {
    const dir = makeConfigDir({ 'plugins.yml': 'plugins:\n  - use: constructor\n' })
    expect(messageOf(dir)).toContain('which is not a known plugin')
  })
})
