import { definePlugin, type PluginFactory } from '@wonderroom/core'

/** A small item-type plugin. It shows the plugin shape and drives the engine tests. */
const curios: PluginFactory = (settings) => {
  const slug = typeof settings.slug === 'string' ? settings.slug : 'curios'
  const label = typeof settings.label === 'string' ? settings.label : 'Curio'
  const labelPlural = typeof settings.labelPlural === 'string' ? settings.labelPlural : `${label}s`
  return definePlugin({
    name: 'curios',
    kind: 'item-type',
    itemType: {
      slug,
      labels: { singular: label, plural: labelPlural },
      fields: [
        { name: 'material', type: 'text' },
        { name: 'acquiredFrom', type: 'text' },
      ],
    },
  })
}

export default curios
