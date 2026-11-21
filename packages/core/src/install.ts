import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse, parseDocument } from 'yaml'
import { orderPlugins } from './order'
import { StartError, type PluginFactory, type WonderRoomPlugin } from './plugin'

export type Catalog = Record<string, PluginFactory>

export type Install = {
  site: { name: string }
  plugins: WonderRoomPlugin[]
  /** plugins.yml `confirm:` lines, as written. */
  confirm: string[]
}

type Settings = Record<string, unknown>

function readOptionalSettings(configDir: string, name: string): Settings {
  const file = join(configDir, 'config.d', `${name}.yml`)
  if (!existsSync(file)) return {}
  return (parse(readFileSync(file, 'utf8')) as Settings | null) ?? {}
}

function readPluginsFile(configDir: string): { plugins?: unknown; confirm?: string[] } {
  const file = join(configDir, 'plugins.yml')
  if (!existsSync(file)) {
    throw new StartError(`No plugins.yml in ${configDir}. Create one that lists your plugins.`)
  }
  const document = parseDocument(readFileSync(file, 'utf8'))
  const [problem] = document.errors
  if (problem) {
    const line = problem.linePos?.[0].line ?? 1
    throw new StartError(`plugins.yml line ${line}: ${problem.message.split('\n')[0]}`)
  }
  return document.toJS() ?? {}
}

export function loadInstall(configDir: string, catalog: Catalog): Install {
  const { plugins: entries, confirm } = readPluginsFile(configDir)
  if (!Array.isArray(entries)) throw new StartError('plugins.yml: "plugins" must be a list.')

  const plugins = entries.map((entry: Settings | null, index) => {
    const position = index + 1
    const { use, ...ownSettings } = entry ?? {}
    if (typeof use !== 'string') throw new StartError(`plugins.yml entry ${position} has no "use".`)
    if ('from' in ownSettings) {
      throw new StartError(
        `plugins.yml entry ${position} uses "from". Plugins from npm or git come in a later version.`,
      )
    }
    const factory = catalog[use]
    if (!factory) {
      throw new StartError(
        `plugins.yml lists "${use}", which is not a known plugin. Known plugins: ${Object.keys(catalog).join(', ')}.`,
      )
    }
    return factory({ ...readOptionalSettings(configDir, use), ...ownSettings })
  })

  const site = readOptionalSettings(configDir, 'site')
  return {
    site: { name: typeof site.name === 'string' ? site.name : 'WonderRoom' },
    plugins: orderPlugins(plugins),
    confirm: confirm ?? [],
  }
}
