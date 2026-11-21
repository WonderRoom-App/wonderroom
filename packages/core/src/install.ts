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

/** Reads a YAML file; `name` is the path shown in messages. */
function readYaml(file: string, name: string): unknown {
  const document = parseDocument(readFileSync(file, 'utf8'))
  const [problem] = document.errors
  if (problem) {
    const line = problem.linePos?.[0].line ?? 1
    throw new StartError(`${name} line ${line}: ${problem.message.split('\n')[0]}`)
  }
  return document.toJS()
}

function readOptionalSettings(configDir: string, name: string): Settings {
  const file = join(configDir, 'config.d', `${name}.yml`)
  if (!existsSync(file)) return {}
  const settings = readYaml(file, `config.d/${name}.yml`) ?? {}
  if (typeof settings !== 'object' || Array.isArray(settings)) {
    throw new StartError(`config.d/${name}.yml must be a mapping of settings.`)
  }
  return settings as Settings
}

function readPluginsFile(configDir: string): { plugins?: unknown; confirm?: unknown } {
  const file = join(configDir, 'plugins.yml')
  if (!existsSync(file)) {
    throw new StartError(`No plugins.yml in ${configDir}. Create one that lists your plugins.`)
  }
  return (readYaml(file, 'plugins.yml') as object | null) ?? {}
}

export function loadInstall(configDir: string, catalog: Catalog): Install {
  const { plugins: entries, confirm } = readPluginsFile(configDir)
  if (!Array.isArray(entries)) throw new StartError('plugins.yml: "plugins" must be a list.')
  const confirmLines = confirm ?? []
  if (!Array.isArray(confirmLines) || !confirmLines.every((line) => typeof line === 'string')) {
    throw new StartError('plugins.yml: "confirm" must be a list of text lines.')
  }

  const plugins = entries.map((entry: Settings | null, index) => {
    const position = index + 1
    const { use, ...ownSettings } = entry ?? {}
    if (typeof use !== 'string') throw new StartError(`plugins.yml entry ${position} has no "use".`)
    if ('from' in ownSettings) {
      throw new StartError(
        `plugins.yml entry ${position} uses "from". Plugins from npm or git come in a later version.`,
      )
    }
    if (!Object.hasOwn(catalog, use)) {
      throw new StartError(
        `plugins.yml lists "${use}", which is not a known plugin. Known plugins: ${Object.keys(catalog).join(', ')}.`,
      )
    }
    return catalog[use]({ ...readOptionalSettings(configDir, use), ...ownSettings })
  })

  const site = readOptionalSettings(configDir, 'site')
  if (site.name !== undefined && typeof site.name !== 'string') {
    throw new StartError('config.d/site.yml: "name" must be text.')
  }
  return {
    site: { name: site.name ?? 'WonderRoom' },
    plugins: orderPlugins(plugins),
    confirm: confirmLines,
  }
}
