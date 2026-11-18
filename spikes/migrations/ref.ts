// Item reference spike: link Featured to a coin, read it back, filter by type, delete the coin.
// Throwaway. Run after migrate: WR_REF=pair|index WR_PLUGINS=... npx tsx ref.ts
import { getPayload } from 'payload'
import config from './payload.config.ts'

const mode = process.env.WR_REF
const payload = await getPayload({ config })
const log = (label: string, value: unknown) => console.log(`${label}:`, JSON.stringify(value))

const typewriter = await payload.create({ collection: 'typewriters' as any, data: { title: 'Royal KMM' } })
const coin = await payload.create({ collection: 'coins' as any, data: { title: 'Athenian owl' } })
log('ids', { typewriter: typewriter.id, coin: coin.id })

if (mode === 'index') {
  const items = await payload.find({ collection: 'items' as any, limit: 10 })
  log('index rows', items.docs.map((d: any) => [d.id, d.itemType, d.itemId, d.title]))
  await payload.update({ collection: 'coins' as any, id: coin.id, data: { title: 'Owl tetradrachm' } })
  const renamed = await payload.find({ collection: 'items' as any, where: { itemType: { equals: 'coins' } } })
  log('index title after rename', renamed.docs[0]?.title)
}

// Link Featured to the coin.
const coinRef =
  mode === 'pair'
    ? { itemType: 'coins', itemId: coin.id }
    : {
        machine: (
          await payload.find({
            collection: 'items' as any,
            where: { itemType: { equals: 'coins' }, itemId: { equals: coin.id } },
          })
        ).docs[0].id,
      }
const featured = await payload.create({ collection: 'featured' as any, data: coinRef })
log('featured', featured)

// A bad reference: does anything stop it?
try {
  const bad = mode === 'pair' ? { itemType: 'coins', itemId: 9999 } : { machine: 9999 }
  await payload.create({ collection: 'featured' as any, data: bad })
  log('bad reference', 'ACCEPTED')
} catch (err) {
  log('bad reference', `rejected: ${String(err).slice(0, 160)}`)
}

// Filter: every featured coin.
const where = mode === 'pair' ? { itemType: { equals: 'coins' } } : { 'machine.itemType': { equals: 'coins' } }
try {
  const coinsFeatured = await payload.find({ collection: 'featured' as any, where })
  log('featured coins count', coinsFeatured.totalDocs)
} catch (err) {
  log('filter', `FAILED: ${String(err).slice(0, 200)}`)
}

// Delete the coin, then read Featured again.
try {
  await payload.delete({ collection: 'coins' as any, id: coin.id })
  log('delete coin', 'OK')
} catch (err) {
  log('delete coin', `FAILED: ${String(err).slice(0, 300)}`)
}
const after = await payload.find({ collection: 'featured' as any, depth: 1 })
log('featured after delete', after.docs)
if (mode === 'index') {
  const items = await payload.find({ collection: 'items' as any, limit: 10 })
  log('index rows after delete', items.docs.map((d: any) => [d.id, d.itemType, d.itemId]))
}
process.exit(0)
