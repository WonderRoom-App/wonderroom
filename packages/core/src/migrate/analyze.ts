export type Snapshot = { tables: Record<string, any>; enums: Record<string, any> } & Record<string, unknown>

export type SchemaChange = {
  addedTables: string[]
  removedTables: string[]
  addedColumns: { table: string; column: string; notNull: boolean; hasDefault: boolean }[]
  removedColumns: { table: string; column: string }[]
  addedEnums: string[]
  removedEnums: string[]
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
    retypedColumns: [],
    newlyNotNull: [],
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

const list = (names: string[]) => names.join(', ')
const SLUG_NOTE = "A plugin's slug can't change once created. Change its label or URL path instead."
// Payload keeps one "<table>_id" column per collection in these two tables.
const PAYLOAD_RELS_TABLES = ['payload_locked_documents_rels', 'payload_preferences_rels']

export function planMigration(
  change: SchemaChange,
  input: { confirm: string[]; latestMigration: string | null; tablesWithRows: Set<string> },
): MigrationPlan {
  const { confirm, latestMigration, tablesWithRows } = input
  const problems: string[] = []
  const removals: Removal[] = []
  const isConfirmed = (key: string) => confirm.includes(key)
  // Returns the confirm key, or null on a fresh install, where nothing can be confirmed.
  const keyFor = (action: string) => (latestMigration === null ? null : `${action} @ ${latestMigration}`)
  const needConfirm = (problem: string, keys: (string | null)[]) =>
    problems.push(
      keys.includes(null)
        ? `${problem} No migration exists yet, so nothing can be confirmed. This should not happen. Check the migrations folder.`
        : `${problem} To allow this, add ${keys.length > 1 ? 'these lines' : 'this line'} to confirm: in plugins.yml:\n${keys.join("\n")}`,
    )

  // Tables. A removed table with another removed table as its name prefix is a child table.
  const isChildTable = (table: string) => change.removedTables.some((other) => other !== table && table.startsWith(`${other}_`))
  const removedRoots = change.removedTables.filter((table) => !isChildTable(table))
  const rootOf = (table: string) => removedRoots.find((root) => table === root || table.startsWith(`${root}_`))!
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
  for (const table of change.removedTables) {
    const root = rootOf(table)
    if (confirmedRoots.has(root)) removals.push({ key: keyFor(`drop table ${root}`)!, table })
  }

  // Enums. A confirmed table drop covers enum_<table>_*, a confirmed column drop covers enum_<table>_<column>.
  const enumCover = (enumName: string): { key: string; table: string } | undefined => {
    for (const root of confirmedRoots) {
      if (enumName.startsWith(`enum_${root}_`)) return { key: keyFor(`drop table ${root}`)!, table: root }
    }
    for (const { table, column } of change.removedColumns) {
      const key = keyFor(`drop column ${table}.${column}`)
      if (enumName === `enum_${table}_${column}` && key !== null && isConfirmed(key)) return { key, table }
    }
  }
  const uncoveredEnums: string[] = []
  for (const enumName of change.removedEnums) {
    const cover = enumCover(enumName)
    if (cover) removals.push({ ...cover, enum: enumName })
    else uncoveredEnums.push(enumName)
  }
  if (uncoveredEnums.length) {
    const swap = change.addedEnums.length ? ` Enum ${list(change.addedEnums)} is new. The engine can't tell a rename from a swap.` : ''
    problems.push(`Enum ${list(uncoveredEnums)} is gone from the schema, and no confirmed table or column drop covers it.${swap} Put the field back, or confirm the drop of its table or column.`)
  }

  // Columns.
  const removedTableSet = new Set(change.removedTables)
  const columnsByTable = new Map<string, string[]>()
  for (const { table, column } of change.removedColumns) {
    const owner = column.endsWith('_id') ? column.slice(0, -3) : null
    if (PAYLOAD_RELS_TABLES.includes(table) && owner !== null && removedTableSet.has(owner)) {
      // Covered by the table drop. If that drop is not confirmed, the table problem above already stops the start.
      if (confirmedRoots.has(rootOf(owner))) removals.push({ key: keyFor(`drop table ${rootOf(owner)}`)!, table, column })
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
    if (key !== null && isConfirmed(key)) removals.push({ key, table, column })
    else needConfirm(`Column ${table}.${column} changes type from ${from} to ${to}. The data may not convert.`, [key])
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

export function removeFromSnapshot(before: Snapshot, removals: Removal[]): Snapshot {
  const snapshot = structuredClone(before)
  for (const { table, column, enum: enumName } of removals) {
    if (enumName !== undefined) {
      delete snapshot.enums[findKey(snapshot.enums, enumName) ?? '']
      continue
    }
    const tableKey = findKey(snapshot.tables, table)
    if (tableKey === undefined) continue
    if (column === undefined) delete snapshot.tables[tableKey]
    else delete snapshot.tables[tableKey].columns[column]
  }
  return snapshot
}
