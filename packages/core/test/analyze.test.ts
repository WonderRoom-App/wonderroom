import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, test } from 'vitest'
import pg from 'pg'
import { withTestDatabase } from './helpers/db'
import { analyzeSchemaChange, planMigration, removalMigration, removeFromSnapshot, type SchemaChange, type Snapshot } from '../src/migrate/analyze'

type Column = { type?: string; notNull?: boolean; default?: string }
const table = (columns: Record<string, Column>) => ({
  columns: Object.fromEntries(Object.entries(columns).map(([name, c]) => [name, { name, type: 'varchar', notNull: false, ...c }])),
  indexes: {},
})
const snapshot = (tables: Record<string, Record<string, Column>>, enums: string[] = []): Snapshot => ({
  version: '7',
  tables: Object.fromEntries(Object.entries(tables).map(([name, columns]) => [`public.${name}`, { name, ...table(columns) }])),
  enums: Object.fromEntries(enums.map((name) => [`public.${name}`, { name, values: ['a'] }])),
})
const emptyChange = (over: Partial<SchemaChange> = {}): SchemaChange => ({
  addedTables: [], removedTables: [], addedColumns: [], removedColumns: [],
  addedEnums: [], removedEnums: [], changedEnums: [], retypedColumns: [], newlyNotNull: [], ...over,
})
const LATEST = '20261118_164300_wonderroom'
const emptySnapshot = snapshot({})
const plan = (change: SchemaChange, confirm: string[] = [], tablesWithRows: string[] = [], latestMigration: string | null = LATEST, before: Snapshot = emptySnapshot) =>
  planMigration(change, { confirm, latestMigration, tablesWithRows: new Set(tablesWithRows), before })
const task2 = (file: string) => JSON.parse(readFileSync(new URL(`../../../spikes/migrations/record/task2/${file}`, import.meta.url), 'utf8'))
// Adds a Payload-style parent foreign key (child.<column> -> parent.id) to a snapshot.
const withParentKey = (snap: Snapshot, child: string, parent: string, column = 'parent_id'): Snapshot => {
  snap.tables[`public.${child}`].foreignKeys = {
    [`${child}_${column}_fk`]: { name: `${child}_${column}_fk`, tableFrom: child, tableTo: parent, columnsFrom: [column], columnsTo: ['id'] },
  }
  return snap
}
const stopMessage = (result: ReturnType<typeof plan>) => {
  if (result.kind !== 'stop') throw new Error(`expected stop, got ${result.kind}`)
  return result.message
}

describe('analyzeSchemaChange', () => {
  const base = snapshot({ a: { x: {}, y: {} } }, ['enum_a_s'])
  test('tables', () => {
    const c = analyzeSchemaChange(base, snapshot({ b: { x: {} } }, ['enum_a_s']))
    expect(c.addedTables).toEqual(['b'])
    expect(c.removedTables).toEqual(['a'])
  })
  test('columns', () => {
    const c = analyzeSchemaChange(base, snapshot({ a: { x: {}, z: { notNull: true, default: "'q'" }, w: { notNull: true } } }, ['enum_a_s']))
    expect(c.removedColumns).toEqual([{ table: 'a', column: 'y' }])
    expect(c.addedColumns).toEqual([
      { table: 'a', column: 'z', notNull: true, hasDefault: true },
      { table: 'a', column: 'w', notNull: true, hasDefault: false },
    ])
  })
  test('enums', () => {
    const c = analyzeSchemaChange(base, snapshot({ a: { x: {}, y: {} } }, ['enum_a_t']))
    expect(c.addedEnums).toEqual(['enum_a_t'])
    expect(c.removedEnums).toEqual(['enum_a_s'])
  })
  test('retyped', () => {
    const c = analyzeSchemaChange(base, snapshot({ a: { x: { type: 'integer' }, y: {} } }, ['enum_a_s']))
    expect(c.retypedColumns).toEqual([{ table: 'a', column: 'x', from: 'varchar', to: 'integer' }])
  })
  test('newly not null', () => {
    const c = analyzeSchemaChange(base, snapshot({ a: { x: { notNull: true }, y: {} } }, ['enum_a_s']))
    expect(c.newlyNotNull).toEqual([{ table: 'a', column: 'x' }])
  })
  test('no change', () => {
    expect(analyzeSchemaChange(base, structuredClone(base))).toEqual(emptyChange())
  })
})

describe('planMigration', () => {
  const dropCoins = emptyChange({ removedTables: ['coins'] })
  const dropKey = `drop table coins @ ${LATEST}`

  test('none', () => expect(plan(emptyChange())).toEqual({ kind: 'none' }))
  test('only additions', () => {
    expect(plan(emptyChange({ addedTables: ['coins'], addedEnums: ['enum_coins_s'] }))).toEqual({ kind: 'apply', removals: [] })
  })
  test('unconfirmed table removal stops with the exact line', () => {
    expect(stopMessage(plan(dropCoins))).toContain(dropKey)
  })
  test('confirmed table removal applies', () => {
    expect(plan(dropCoins, [dropKey])).toEqual({ kind: 'apply', removals: [{ key: dropKey, table: 'coins' }] })
  })
  test('confirmation for an older migration does not match', () => {
    expect(plan(dropCoins, ['drop table coins @ 20250101_000000_old']).kind).toBe('stop')
  })
  test('removal on a fresh install stops', () => {
    expect(stopMessage(plan(dropCoins, [], [], null))).toContain('No migration exists yet')
  })
  test('removed and added table, unconfirmed', () => {
    const message = stopMessage(plan(emptyChange({ removedTables: ['coins'], addedTables: ['stamps'] })))
    expect(message).toContain('coins')
    expect(message).toContain('stamps')
    expect(message).toContain("can't tell a rename from a swap")
    expect(message).toContain("A plugin's slug can't change once created. Change its label or URL path instead.")
  })
  test('removed and added table, confirmed (swap)', () => {
    expect(plan(emptyChange({ removedTables: ['coins'], addedTables: ['stamps'] }), [dropKey]).kind).toBe('apply')
  })
  test('child tables, enums and payload columns ride on the table drop', () => {
    const before = snapshot({ coins: { id: {}, status: { type: 'enum_coins_status' } }, coins_rels: { id: {} }, coins_photos: { id: {} }, coins_photos_tags: { id: {} } }, ['enum_coins_status'])
    withParentKey(before, 'coins_rels', 'coins')
    withParentKey(before, 'coins_photos', 'coins', '_parent_id')
    withParentKey(before, 'coins_photos_tags', 'coins_photos', '_parent_id')
    const change = emptyChange({
      removedTables: ['coins', 'coins_rels', 'coins_photos', 'coins_photos_tags'],
      removedEnums: ['enum_coins_status'],
      removedColumns: [
        { table: 'payload_locked_documents_rels', column: 'coins_id' },
        { table: 'payload_preferences_rels', column: 'coins_id' },
      ],
    })
    expect(plan(change, [dropKey], [], LATEST, before)).toEqual({
      kind: 'apply',
      removals: [
        { key: dropKey, table: 'coins' },
        { key: dropKey, table: 'coins_rels' },
        { key: dropKey, table: 'coins_photos' },
        { key: dropKey, table: 'coins_photos_tags' },
        { key: dropKey, table: 'coins', enum: 'enum_coins_status' },
        { key: dropKey, table: 'payload_locked_documents_rels', column: 'coins_id' },
        { key: dropKey, table: 'payload_preferences_rels', column: 'coins_id' },
      ],
    })
  })
  test('an unconfirmed table drop does not list its enums separately', () => {
    const before = snapshot({ coins: { status: { type: 'enum_coins_status' } } }, ['enum_coins_status'])
    const message = stopMessage(plan(emptyChange({ removedTables: ['coins'], removedEnums: ['enum_coins_status'] }), [], [], LATEST, before))
    expect(message).toContain(dropKey)
    expect(message).not.toContain('enum_coins_status')
  })
  test('an unrelated table with a matching prefix needs its own key', () => {
    const before = withParentKey(snapshot({ coins: {}, coins_rels: {}, coins_extra: {} }), 'coins_rels', 'coins')
    const message = stopMessage(plan(emptyChange({ removedTables: ['coins', 'coins_rels', 'coins_extra'] }), [dropKey], [], LATEST, before))
    expect(message).toContain(`drop table coins_extra @ ${LATEST}`)
    expect(message).not.toContain(`drop table coins @ ${LATEST}`)
  })
  test('an enum used by a surviving table is not covered', () => {
    const before = snapshot({ coins: { status: { type: 'enum_coins_status' } }, other: { status: { type: 'enum_coins_status' } } }, ['enum_coins_status'])
    const message = stopMessage(plan(emptyChange({ removedTables: ['coins'], removedEnums: ['enum_coins_status'] }), [dropKey], [], LATEST, before))
    expect(message).toContain('enum_coins_status')
  })
  test('confirmed retype applies and removes nothing', () => {
    const change = emptyChange({ retypedColumns: [{ table: 'coins', column: 'year', from: 'varchar', to: 'integer' }] })
    expect(plan(change, [`retype coins.year @ ${LATEST}`])).toEqual({ kind: 'apply', removals: [] })
  })
  describe('changed enum values', () => {
    const key = `drop values enum_coins_grade.good,fair @ ${LATEST}`
    test('added values alone apply', () => {
      const change = emptyChange({ changedEnums: [{ enum: 'enum_coins_grade', removedValues: [], addedValues: ['mint'] }] })
      expect(plan(change)).toEqual({ kind: 'apply', removals: [] })
    })
    test('removed values stop, with the key and a note about rows', () => {
      const change = emptyChange({ changedEnums: [{ enum: 'enum_coins_grade', removedValues: ['good', 'fair'], addedValues: [] }] })
      const message = stopMessage(plan(change))
      expect(message).toContain(key)
      expect(message).toContain('Change the rows')
    })
    test('removed values apply when confirmed', () => {
      const change = emptyChange({ changedEnums: [{ enum: 'enum_coins_grade', removedValues: ['good', 'fair'], addedValues: ['mint'] }] })
      expect(plan(change, [key])).toEqual({ kind: 'apply', removals: [] })
    })
  })
  test('analyze reports changed enum values in before-order', () => {
    const before = snapshot({}, ['enum_a_s'])
    before.enums['public.enum_a_s'].values = ['x', 'y', 'z']
    const after = snapshot({}, ['enum_a_s'])
    after.enums['public.enum_a_s'].values = ['x', 'w', 'z']
    const c = analyzeSchemaChange(before, after)
    expect(c.changedEnums).toEqual([{ enum: 'enum_a_s', removedValues: ['y'], addedValues: ['w'] }])
    expect(c.addedEnums).toEqual([])
  })
  test('only the first line is needed for a table with children', () => {
    const before = withParentKey(snapshot({ coins: {}, coins_rels: {} }), 'coins_rels', 'coins')
    const message = stopMessage(plan(emptyChange({ removedTables: ['coins', 'coins_rels'] }), [], [], LATEST, before))
    expect(message).toContain(dropKey)
    expect(message).not.toContain('coins_rels @')
  })
  test('a confirmed drop does not cover a table that still exists', () => {
    // coins_extra exists in both snapshots, so it is not in removedTables and has no removal.
    const before = withParentKey(snapshot({ coins: {}, coins_rels: {} }), 'coins_rels', 'coins')
    const result = plan(emptyChange({ removedTables: ['coins', 'coins_rels'] }), [dropKey], [], LATEST, before)
    expect(result).toMatchObject({ kind: 'apply' })
    expect(result.kind === 'apply' && result.removals.map((r) => r.table)).toEqual(['coins', 'coins_rels'])
  })
  test('a payload column for a table that is not removed still needs a key', () => {
    const message = stopMessage(plan(emptyChange({ removedColumns: [{ table: 'payload_locked_documents_rels', column: 'coins_id' }] })))
    expect(message).toContain(`drop column payload_locked_documents_rels.coins_id @ ${LATEST}`)
  })
  test('removed and added enum, not covered', () => {
    const message = stopMessage(plan(emptyChange({ removedEnums: ['enum_a_old'], addedEnums: ['enum_a_new'] })))
    expect(message).toContain('enum_a_old')
    expect(message).toContain('enum_a_new')
  })
  test('removed and added column in one table', () => {
    const message = stopMessage(plan(emptyChange({
      removedColumns: [{ table: 'coins', column: 'old_name' }],
      addedColumns: [{ table: 'coins', column: 'new_name', notNull: false, hasDefault: false }],
    })))
    expect(message).toContain('coins.old_name')
    expect(message).toContain('new_name')
    expect(message).toContain('M1 has no declared renames')
    expect(message).toContain(`drop column coins.old_name @ ${LATEST}`)
  })
  test('confirmed column drop applies, and covers its enum', () => {
    const key = `drop column coins.status @ ${LATEST}`
    const before = snapshot({ coins: { status: { type: 'enum_coins_status' } } }, ['enum_coins_status'])
    const result = plan(emptyChange({ removedColumns: [{ table: 'coins', column: 'status' }], removedEnums: ['enum_coins_status'] }), [key], [], LATEST, before)
    expect(result).toEqual({ kind: 'apply', removals: [
      { key, table: 'coins', enum: 'enum_coins_status' },
      { key, table: 'coins', column: 'status' },
    ] })
  })
  test('retyped column stops unless confirmed', () => {
    const change = emptyChange({ retypedColumns: [{ table: 'coins', column: 'year', from: 'varchar', to: 'integer' }] })
    expect(stopMessage(plan(change))).toContain(`retype coins.year @ ${LATEST}`)
    expect(plan(change, [`retype coins.year @ ${LATEST}`]).kind).toBe('apply')
  })
  test('new NOT NULL column without default on a table with rows', () => {
    const change = emptyChange({ addedColumns: [{ table: 'coins', column: 'grade', notNull: true, hasDefault: false }] })
    const message = stopMessage(plan(change, [], ['coins']))
    expect(message).toContain('coins.grade')
    expect(message).toContain('default')
    expect(plan(change, [], []).kind).toBe('apply')
    expect(plan(emptyChange({ addedColumns: [{ table: 'coins', column: 'grade', notNull: true, hasDefault: true }] }), [], ['coins']).kind).toBe('apply')
  })
  test('column that becomes NOT NULL on a table with rows', () => {
    const message = stopMessage(plan(emptyChange({ newlyNotNull: [{ table: 'coins', column: 'year' }] }), [], ['coins']))
    expect(message).toContain('coins.year')
  })
  test('lists every problem in one message', () => {
    const message = stopMessage(plan(emptyChange({ removedTables: ['coins', 'stamps'] })))
    expect(message).toContain('drop table coins')
    expect(message).toContain('drop table stamps')
  })
})

describe('removeFromSnapshot', () => {
  test('removes listed tables, enums and columns only', () => {
    const before = snapshot({ coins: { a: {} }, coins_rels: { a: {} }, coins_extra: { a: {} }, other: { a: {}, b: {} } }, ['enum_coins_s', 'enum_other_s'])
    const after = removeFromSnapshot(before, [
      { key: 'k', table: 'coins' },
      { key: 'k', table: 'coins_rels' },
      { key: 'k', table: 'coins', enum: 'enum_coins_s' },
      { key: 'k', table: 'other', column: 'b' },
    ])
    expect(Object.keys(after.tables)).toEqual(['public.coins_extra', 'public.other'])
    expect(Object.keys(after.enums)).toEqual(['public.enum_other_s'])
    expect(Object.keys(after.tables['public.other'].columns)).toEqual(['a'])
    expect(Object.keys(before.tables)).toHaveLength(4)
  })
})

describe('child tables need Payload names', () => {
  test('a relationship field named parent does not make another collection a child', () => {
    const before = withParentKey(snapshot({ coins: {}, stamps: { parent_id: {} } }), 'stamps', 'coins')
    const message = stopMessage(plan(emptyChange({ removedTables: ['coins', 'stamps'] }), [dropKey()], ['stamps'], LATEST, before))
    expect(message).toContain(`drop table stamps @ ${LATEST}`)
  })
  test('versions tables chain to their collection', () => {
    const before = snapshot({ coins: {}, _coins_v: {}, _coins_v_rels: {} })
    withParentKey(before, '_coins_v', 'coins')
    withParentKey(before, '_coins_v_rels', '_coins_v')
    const result = plan(emptyChange({ removedTables: ['coins', '_coins_v', '_coins_v_rels'] }), [dropKey()], [], LATEST, before)
    expect(result.kind === 'apply' && result.removals.map((r) => r.table)).toEqual(['coins', '_coins_v', '_coins_v_rels'])
  })
})
const dropKey = () => `drop table coins @ ${LATEST}`

describe('enum retype and made-up column keys', () => {
  const before = snapshot({ coins: { status: { type: 'enum_coins_status' } } }, ['enum_coins_status'])
  const change = emptyChange({
    removedEnums: ['enum_coins_status'],
    retypedColumns: [{ table: 'coins', column: 'status', from: 'enum_coins_status', to: 'varchar' }],
  })
  test('a confirmed retype away from an enum covers the enum, with no removal', () => {
    expect(plan(change, [`retype coins.status @ ${LATEST}`], [], LATEST, before)).toEqual({ kind: 'apply', removals: [] })
  })
  test('an unconfirmed retype away from an enum stops', () => {
    expect(plan(change, [], [], LATEST, before).kind).toBe('stop')
  })
  test('a drop column key for a column that was not removed is ignored', () => {
    const key = `drop column coins.status @ ${LATEST}`
    expect(plan(change, [key], [], LATEST, before).kind).toBe('stop')
  })
})

test('the hint says where the line goes', () => {
  expect(stopMessage(plan(emptyChange({ removedTables: ['coins'] })))).toContain('add this line under confirm: in plugins.yml:')
})

describe('removalMigration against drizzle-kit', () => {
  test('phase 2 after a confirmed collection drop has nothing left to drop', async () => {
    const { generateMigration } = createRequire(import.meta.url)('drizzle-kit/api')
    const before = task2('20261118_164330_add_office.json')
    const after = task2('20261118_164426_remove_coins.json.rejected')
    for (const name of ['public.typewriters', 'public.office_machines']) after.tables[name] = before.tables[name]
    const latest = '20261118_164330_add_office'
    const result = planMigration(analyzeSchemaChange(before, after), {
      confirm: [`drop table coins @ ${latest}`, `drop column featured_rels.coins_id @ ${latest}`], latestMigration: latest, tablesWithRows: new Set(), before,
    })
    if (result.kind !== 'apply') throw new Error(result.kind === 'stop' ? result.message : 'none')
    const { statements, snapshot: reduced } = await removalMigration(before, result.removals, generateMigration)
    expect(statements.join('\n')).toContain('DROP TABLE "coins"')
    expect(await generateMigration(reduced, after)).toEqual([])
  })
})

describe('a confirmed collection drop runs on real Postgres', () => {
  test('phase 1 and phase 2 both succeed and coins is gone', async () => {
    const { generateMigration } = createRequire(import.meta.url)('drizzle-kit/api')
    const before = task2('20261118_164330_add_office.json')
    const after = task2('20261118_164426_remove_coins.json.rejected')
    for (const name of ['public.typewriters', 'public.office_machines']) after.tables[name] = before.tables[name]
    const latest = '20261118_164330_add_office'
    const result = planMigration(analyzeSchemaChange(before, after), {
      confirm: [`drop table coins @ ${latest}`, `drop column featured_rels.coins_id @ ${latest}`], latestMigration: latest, tablesWithRows: new Set(), before,
    })
    if (result.kind !== 'apply') throw new Error(result.kind === 'stop' ? result.message : 'none')
    await withTestDatabase(async (databaseUrl) => {
      const client = new pg.Client({ connectionString: databaseUrl })
      await client.connect()
      try {
        for (const statement of await generateMigration({ ...before, tables: {}, enums: {} }, before)) await client.query(statement)
        await client.query(`INSERT INTO coins (id, title) VALUES (1, 'penny')`)
        await client.query('INSERT INTO featured (id) VALUES (1)')
        await client.query(`INSERT INTO featured_rels ("order", parent_id, path, coins_id) VALUES (1, 1, 'items', 1)`)
        const { statements, snapshot } = await removalMigration(before, result.removals, generateMigration)
        await client.query('BEGIN')
        for (const statement of statements) await client.query(statement)
        for (const statement of await generateMigration(snapshot, after)) await client.query(statement)
        await client.query('COMMIT')
        const found = await client.query(`SELECT to_regclass('public.coins') AS coins`)
        expect(found.rows[0].coins).toBeNull()
      } finally {
        await client.end()
      }
    })
  })
})
