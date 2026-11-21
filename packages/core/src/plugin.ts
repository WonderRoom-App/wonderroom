import type { CollectionConfig, Field } from 'payload'

export class StartError extends Error {}

export type PluginKind = 'item-type' | 'add-on' | 'integration' | 'theme'

export type ItemTypeDefinition = {
  slug: string
  labels: { singular: string; plural: string }
  /** Payload fields, added after the core fields. */
  fields: Field[]
}

export type WonderRoomPlugin = {
  /** Matches the `use:` name in plugins.yml. */
  name: string
  kind: PluginKind
  /** Plugin names. */
  requires?: string[]
  /** Required when kind is 'item-type', forbidden otherwise. */
  itemType?: ItemTypeDefinition
  collections?: CollectionConfig[]
}

export type PluginFactory = (settings: Record<string, unknown>) => WonderRoomPlugin

const kinds: PluginKind[] = ['item-type', 'add-on', 'integration', 'theme']

export function definePlugin(plugin: WonderRoomPlugin): WonderRoomPlugin {
  if (!plugin.name) throw new StartError('A plugin has an empty name. Give it a name.')
  if (!kinds.includes(plugin.kind)) {
    throw new StartError(`Plugin ${plugin.name} has the unknown kind "${plugin.kind}". Use one of: ${kinds.join(', ')}.`)
  }
  if (plugin.kind === 'item-type' && !plugin.itemType) {
    throw new StartError(`Plugin ${plugin.name} is an item-type plugin, so it must define itemType.`)
  }
  if (plugin.kind !== 'item-type' && plugin.itemType) {
    throw new StartError(`Plugin ${plugin.name} is not an item-type plugin, so it must not define itemType.`)
  }
  return plugin
}
