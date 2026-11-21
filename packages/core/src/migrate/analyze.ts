export type Snapshot = { tables: Record<string, any>; enums: Record<string, any> } & Record<string, unknown>

export type SchemaChange = {
  addedTables: string[]
  removedTables: string[]
  addedColumns: { table: string; column: string; notNull: boolean; hasDefault: boolean }[]
  removedColumns: { table: string; column: string }[]
  addedEnums: string[]
  removedEnums: string[]
  changedEnums: { enum: string; removedValues: string[]; addedValues: string[] }[]
  retypedColumns: { table: string; column: string; from: string; to: string }[]
  newlyNotNull: { table: string; column: string }[]
}

// A removal the engine takes out of the snapshot before it asks Drizzle for the diff.
// With neither `column` nor `enum`, it removes the whole table. `key` is the confirm key that covers it.
export type Removal = { key: string; table: string; column?: string; enum?: string }

export type MigrationPlan =
  | { kind: 'none' }
  | { kind: 'apply'; removals: Removal[] }
  | { kind: 'stop'; message: string }

// Snapshot keys look like "public.coins". Everything here uses the bare name.
const bareName = (key: string) => key.replace(/^[^.]+\./, '')
const bareNames = (section: Record<string, any>) => Object.keys(section).map(bareName)
const findKey = (section: Record<string, any>, name: string) => Object.keys(section).find((key) => bareName(key) === name)
const columnsOf = (snapshot: Snapshot, table: string): Record<string, any> =>
  snapshot.tables[findKey(snapshot.tables, table)!]?.columns ?? {}

export function analyzeSchemaChange(before: Snapshot, after: Snapshot): SchemaChange {
  const beforeTables = bareNames(before.tables)
  const afterTables = bareNames(after.tables)
  const beforeEnums = bareNames(before.enums)
  const afterEnums = bareNames(after.enums)
  const change: SchemaChange = {
    addedTables: afterTables.filter((name) => !beforeTables.includes(name)),
    removedTables: beforeTables.filter((name) => !afterTables.includes(name)),
    addedColumns: [],
    removedColumns: [],
    addedEnums: afterEnums.filter((name) => !beforeEnums.includes(name)),
    removedEnums: beforeEnums.filter((name) => !afterEnums.includes(name)),
    changedEnums: [],
    retypedColumns: [],
    newlyNotNull: [],
  }
  for (const name of beforeEnums.filter((enumName) => afterEnums.includes(enumName))) {
    const was: string[] = before.enums[findKey(before.enums, name)!].values ?? []
    const now: string[] = after.enums[findKey(after.enums, name)!].values ?? []
    const removedValues = was.filter((value) => !now.includes(value))
    const addedValues = now.filter((value) => !was.includes(value))
    if (removedValues.length || addedValues.length) change.changedEnums.push({ enum: name, removedValues, addedValues })
  }
  for (const table of beforeTables.filter((name) => afterTables.includes(name))) {
    const was = columnsOf(before, table)
    const now = columnsOf(after, table)
    for (const column of Object.keys(now)) {
      if (!(column in was)) {
        const { notNull, default: columnDefault } = now[column]
        change.addedColumns.push({ table, column, notNull: !!notNull, hasDefault: columnDefault !== undefined && columnDefault !== null })
        continue
      }
      if (was[column].type !== now[column].type) change.retypedColumns.push({ table, column, from: was[column].type, to: now[column].type })
      if (!was[column].notNull && now[column].notNull) change.newlyNotNull.push({ table, column })
    }
    for (const column of Object.keys(was)) if (!(column in now)) change.removedColumns.push({ table, column })
  }
  return change
}

// Payload names a child table "<parent>_<something>", and a versions table "_<parent>_v".
// A plain relationship field called "parent" also makes a parent_id key, so the key alone is not enough.
const hasPayloadChildName = (child: string, parent: string) => child.startsWith(`${parent}_`) || child === `_${parent}_v`

const list = (names: string[]) => names.join(', ')
const SLUG_NOTE = "A plugin's slug can't change once created. Change its label or URL path instead."
// Payload keeps one "<table>_id" column per collection in these two tables.
const PAYLOAD_RELS_TABLES = ['payload_locked_documents_rels', 'payload_preferences_rels']

export function planMigration(
  change: SchemaChange,
  input: { confirm: string[]; latestMigration: string | null; tablesWithRows: Set<string>; before: Snapshot },
): MigrationPlan {
  const { confirm, latestMigration, tablesWithRows, before } = input
  const problems: string[] = []
  const removals: Removal[] = []
  const isConfirmed = (key: string) => confirm.includes(key)
  // Returns the confirm key, or null on a fresh install, where nothing can be confirmed.
  const keyFor = (action: string) => (latestMigration === null ? null : `${action} @ ${latestMigration}`)
  const needConfirm = (problem: string, keys: (string | null)[]) =>
    problems.push(
      keys.includes(null)
        ? `${problem} No migration exists yet, so nothing can be confirmed. This should not happen. Check the migrations folder.`
        : `${problem} To allow this, add ${keys.length > 1 ? 'these lines' : 'this line'} under confirm: in plugins.yml:\n${keys.join("\n")}`,
    )

  // Tables. A removed table is a child when it has a Payload parent key (parent_id or _parent_id)
  // to another removed table. Only names that share a prefix by accident are not children.
  const removedTableSet = new Set(change.removedTables)
  const parentOf = (table: string): string | undefined => {
    const foreignKeys = before.tables[findKey(before.tables, table) ?? '']?.foreignKeys ?? {}
    const parentKey = Object.values<any>(foreignKeys).find(
      (fk) => fk.tableFrom === table && removedTableSet.has(fk.tableTo) && fk.tableTo !== table && hasPayloadChildName(table, fk.tableTo) && fk.columnsFrom.some((column: string) => column === 'parent_id' || column === '_parent_id'),
    )
    return parentKey?.tableTo
  }
  const rootOf = (table: string) => {
    let root = table
    for (let hops = 0; hops <= change.removedTables.length; hops++) {
      const parent = parentOf(root)
      if (parent === undefined) return root
      root = parent
    }
    return table // a foreign key loop: the table asks for its own key
  }
  const removedRoots = change.removedTables.filter((table) => rootOf(table) === table)
  const confirmedRoots = new Set<string>()
  const unconfirmedRoots: string[] = []
  for (const root of removedRoots) {
    const key = keyFor(`drop table ${root}`)
    if (key !== null && isConfirmed(key)) confirmedRoots.add(root)
    else unconfirmedRoots.push(root)
  }
  const addedRoots = change.addedTables.filter((table) => !change.addedTables.some((other) => other !== table && table.startsWith(`${other}_`)))
  for (const root of unconfirmedRoots) {
    const swap = addedRoots.length
      ? ` Table ${list(addedRoots)} is new. The engine can't tell a rename from a swap. ${SLUG_NOTE}`
      : ''
    needConfirm(`Table ${root} is gone from the schema. Its rows would be lost.${swap}`, [keyFor(`drop table ${root}`)])
  }
  const tableCoverKey = (table: string) => (confirmedRoots.has(rootOf(table)) ? keyFor(`drop table ${rootOf(table)}`)! : undefined)
  for (const table of change.removedTables) {
    const key = tableCoverKey(table)
    if (key) removals.push({ key, table })
  }

  // Enums. An enum is covered when every column that uses it sits in a covered table or a confirmed dropped column.
  const confirmedColumnKey = (table: string, column: string) => {
    if (!change.removedColumns.some((removed) => removed.table === table && removed.column === column)) return undefined
    const key = keyFor(`drop column ${table}.${column}`)
    return key !== null && isConfirmed(key) ? key : undefined
  }
  const enumCover = (enumName: string): { key: string; table: string; retyped: boolean } | undefined => {
    const users = Object.values<any>(before.tables).flatMap((tableEntry) =>
      Object.values<any>(tableEntry.columns).filter((column) => column.type === enumName).map((column) => ({ table: tableEntry.name as string, column: column.name as string })),
    )
    if (users.length === 0) return undefined
    // A confirmed retype away from the enum frees the column too. Drizzle drops the enum in phase 2.
    const retypeKey = (table: string, column: string) => {
      const key = keyFor(`retype ${table}.${column}`)
      const retyped = change.retypedColumns.some((entry) => entry.table === table && entry.column === column && entry.from === enumName)
      return retyped && key !== null && isConfirmed(key) ? key : undefined
    }
    const keys = users.map(({ table, column }) => {
      const removedKey = tableCoverKey(table) ?? confirmedColumnKey(table, column)
      return { table, key: removedKey ?? retypeKey(table, column), retyped: removedKey === undefined }
    })
    if (keys.some(({ key }) => key === undefined)) return undefined
    return { key: keys[0].key!, table: keys[0].table, retyped: keys.some((entry) => entry.retyped) }
  }
  const uncoveredEnums: string[] = []
  for (const enumName of change.removedEnums) {
    const cover = enumCover(enumName)
    if (cover?.retyped) continue
    if (cover) removals.push({ key: cover.key, table: cover.table, enum: enumName })
    else uncoveredEnums.push(enumName)
  }
  if (uncoveredEnums.length) {
    const swap = change.addedEnums.length ? ` Enum ${list(change.addedEnums)} is new. The engine can't tell a rename from a swap.` : ''
    problems.push(`Enum ${list(uncoveredEnums)} is gone from the schema, and no confirmed table or column drop covers every column that uses it.${swap} Put the field back, or confirm the drop of its table or column.`)
  }
  for (const { enum: enumName, removedValues } of change.changedEnums) {
    if (removedValues.length === 0) continue
    const key = keyFor(`drop values ${enumName}.${removedValues.join(',')}`)
    if (key !== null && isConfirmed(key)) continue
    needConfirm(`Enum ${enumName} loses the values ${list(removedValues)}. Change the rows that hold these values first.`, [key])
  }

  // Columns.
  const columnsByTable = new Map<string, string[]>()
  for (const { table, column } of change.removedColumns) {
    const owner = column.endsWith('_id') ? column.slice(0, -3) : null
    if (PAYLOAD_RELS_TABLES.includes(table) && owner !== null && removedTableSet.has(owner)) {
      // Covered by the table drop. If that drop is not confirmed, the table problem above already stops the start.
      const key = tableCoverKey(owner)
      if (key) removals.push({ key, table, column })
      continue
    }
    const key = keyFor(`drop column ${table}.${column}`)
    if (key !== null && isConfirmed(key)) {
      removals.push({ key, table, column })
      continue
    }
    columnsByTable.set(table, [...(columnsByTable.get(table) ?? []), column])
  }
  for (const [table, columns] of columnsByTable) {
    const added = change.addedColumns.filter((added) => added.table === table).map((added) => added.column)
    const swap = added.length
      ? ` Column ${list(added)} is new in the same table. The engine can't tell a rename from a swap, and M1 has no declared renames.`
      : ''
    needConfirm(`Column ${list(columns.map((column) => `${table}.${column}`))} is gone from the schema. Its data would be lost.${swap}`, columns.map((column) => keyFor(`drop column ${table}.${column}`)))
  }

  for (const { table, column, from, to } of change.retypedColumns) {
    const key = keyFor(`retype ${table}.${column}`)
    // Confirmed: no removal. Drizzle's own SET DATA TYPE keeps the data.
    if (key !== null && isConfirmed(key)) continue
    needConfirm(`Column ${table}.${column} changes type from ${from} to ${to}. The data may not convert.`, [key])
  }

  const needsDefault = [
    ...change.addedColumns.filter((added) => added.notNull && !added.hasDefault),
    ...change.newlyNotNull,
  ].filter(({ table }) => tablesWithRows.has(table))
  for (const { table, column } of needsDefault) {
    problems.push(`Column ${table}.${column} must not be empty, and table ${table} already has rows. The plugin must give this field a default value.`)
  }

  if (problems.length) return { kind: 'stop', message: problems.join('\n') }
  const changed = Object.values(change).some((entry) => entry.length > 0)
  return changed ? { kind: 'apply', removals } : { kind: 'none' }
}

// Postgres drops foreign keys that point at a dropped table.
function dropForeignKeysTo(snapshot: Snapshot, table: string) {
  for (const other of Object.values<any>(snapshot.tables)) {
    for (const [name, foreignKey] of Object.entries<any>(other.foreignKeys ?? {})) {
      if (foreignKey.tableTo === table) delete other.foreignKeys[name]
    }
  }
}

export function removeFromSnapshot(before: Snapshot, removals: Removal[]): Snapshot {
  const snapshot = structuredClone(before)
  const removeColumn = (tableEntry: any, column: string) => {
    delete tableEntry.columns[column]
    // Postgres drops the indexes, foreign keys and constraints on a dropped column. The snapshot must agree.
    for (const [name, index] of Object.entries<any>(tableEntry.indexes ?? {})) {
      if (index.columns?.some((entry: any) => entry.expression === column)) delete tableEntry.indexes[name]
    }
    for (const [name, foreignKey] of Object.entries<any>(tableEntry.foreignKeys ?? {})) {
      if (foreignKey.columnsFrom?.includes(column)) delete tableEntry.foreignKeys[name]
    }
    for (const section of ['uniqueConstraints', 'compositePrimaryKeys']) {
      for (const [name, constraint] of Object.entries<any>(tableEntry[section] ?? {})) {
        if (constraint.columns?.includes(column)) delete tableEntry[section][name]
      }
    }
  }
  for (const { table, column, enum: enumName } of removals) {
    if (enumName !== undefined) {
      delete snapshot.enums[findKey(snapshot.enums, enumName) ?? '']
      continue
    }
    const tableKey = findKey(snapshot.tables, table)
    if (tableKey === undefined) continue
    if (column !== undefined) {
      removeColumn(snapshot.tables[tableKey], column)
      continue
    }
    delete snapshot.tables[tableKey]
    dropForeignKeysTo(snapshot, table)
  }
  return snapshot
}

// Phase 1: the SQL that carries out the confirmed removals, and the snapshot as it stands afterwards.
// DROP TABLE ... CASCADE already drops the foreign keys that point at the table. So the SQL is built from a
// copy of `before` without those keys, or Postgres would fail on a second DROP CONSTRAINT.
// `generateMigration` comes from payload.db.requireDrizzleKit(), so both phases use the same drizzle-kit.
export async function removalMigration(
  before: Snapshot,
  removals: Removal[],
  generateMigration: (prev: any, cur: any) => Promise<string[]>,
): Promise<{ statements: string[]; snapshot: Snapshot }> {
  const snapshot = removeFromSnapshot(before, removals)
  const withoutCascadedKeys = structuredClone(before)
  for (const { table, column, enum: enumName } of removals) {
    if (column === undefined && enumName === undefined) dropForeignKeysTo(withoutCascadedKeys, table)
  }
  return { statements: await generateMigration(withoutCascadedKeys, snapshot), snapshot }
}
