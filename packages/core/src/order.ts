import { StartError, type WonderRoomPlugin } from './plugin'

/** Puts each plugin after everything it requires; otherwise keeps input order. */
export function orderPlugins(plugins: WonderRoomPlugin[]): WonderRoomPlugin[] {
  const byName = new Map<string, WonderRoomPlugin>()
  for (const plugin of plugins) {
    if (byName.has(plugin.name)) throw new StartError(`plugins.yml lists ${plugin.name} twice.`)
    byName.set(plugin.name, plugin)
  }

  const ordered: WonderRoomPlugin[] = []
  const done = new Set<string>()
  const path: string[] = []

  const visit = (plugin: WonderRoomPlugin) => {
    if (done.has(plugin.name)) return
    const loopStart = path.indexOf(plugin.name)
    if (loopStart >= 0) {
      const loop = [...path.slice(loopStart), plugin.name]
      throw new StartError(`These plugins require each other in a loop: ${loop.join(' → ')}.`)
    }
    path.push(plugin.name)
    for (const required of plugin.requires ?? []) {
      const requiredPlugin = byName.get(required)
      if (!requiredPlugin) {
        throw new StartError(`${plugin.name} requires ${required}, but plugins.yml does not list ${required}.`)
      }
      visit(requiredPlugin)
    }
    path.pop()
    done.add(plugin.name)
    ordered.push(plugin)
  }

  plugins.forEach(visit)
  return ordered
}
