import { pathToFileURL } from 'node:url'
import { createWriteStream, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

function take(flag) {
  const index = process.argv.indexOf(flag)
  if (index === -1 || index + 1 >= process.argv.length) {
    return ''
  }
  return process.argv[index + 1]
}

function required(flag) {
  const value = take(flag)
  if (!value) {
    console.error('missing ' + flag)
    process.exit(2)
  }
  return value
}

function quoteIdent(name) {
  return '"' + String(name).split('"').join('""') + '"'
}

function sqlText(value) {
  return "'" + String(value).split("'").join("''") + "'"
}

function rowsOf(result) {
  if (result && Array.isArray(result.rows)) {
    return result.rows
  }
  if (Array.isArray(result)) {
    return result
  }
  return []
}

function tableId(schema, name) {
  return String(schema) + '\u0000' + String(name)
}

function isTrue(value) {
  return value === true || value === 't' || value === 'true'
}

function isGenerated(value) {
  if (value == null) {
    return false
  }
  const text = String(value)
  return text !== '' && text !== ' '
}

function orderTables(ids, edges) {
  const indegree = new Map(ids.map((id) => [id, 0]))
  const after = new Map(ids.map((id) => [id, []]))
  for (const edge of edges) {
    if (!indegree.has(edge.child) || !indegree.has(edge.parent) || edge.child === edge.parent) {
      continue
    }
    indegree.set(edge.child, indegree.get(edge.child) + 1)
    after.get(edge.parent).push(edge.child)
  }
  const ready = ids.filter((id) => indegree.get(id) === 0)
  ready.sort()
  const ordered = []
  while (ready.length > 0) {
    const id = ready.shift()
    ordered.push(id)
    const next = (after.get(id) ?? []).slice().sort()
    for (const child of next) {
      const left = indegree.get(child) - 1
      indegree.set(child, left)
      if (left === 0) {
        ready.push(child)
        ready.sort()
      }
    }
  }
  for (const id of ids) {
    if (!ordered.includes(id)) {
      ordered.push(id)
    }
  }
  return ordered
}

function encodeText(value) {
  if (value === null || value === undefined) {
    return null
  }
  return { t: String(value) }
}

function writeLine(stream, value) {
  const line = JSON.stringify(value) + '\n'
  if (stream.write(line)) {
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      stream.off('drain', onDrain)
      reject(error)
    }
    const onDrain = () => {
      stream.off('error', onError)
      resolve()
    }
    stream.once('error', onError)
    stream.once('drain', onDrain)
  })
}

const USER_TABLES =
  "SELECT n.nspname AS schema, c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind = 'r' AND n.nspname <> 'pg_catalog' AND n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg_%' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e') ORDER BY 1, 2"

const COLUMN_SQL =
  'SELECT a.attname AS name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS notnull, a.attgenerated AS generated, pg_get_expr(ad.adbin, ad.adrelid) AS default_expr FROM pg_attribute a LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum'

const FK_SQL =
  "SELECT nchild.nspname AS child_schema, child.relname AS child_name, nparent.nspname AS parent_schema, parent.relname AS parent_name, a.attname AS child_col, pa.attname AS parent_col FROM pg_constraint con JOIN pg_class child ON child.oid = con.conrelid JOIN pg_namespace nchild ON nchild.oid = child.relnamespace JOIN pg_class parent ON parent.oid = con.confrelid JOIN pg_namespace nparent ON nparent.oid = parent.relnamespace JOIN LATERAL unnest(con.conkey, con.confkey) AS cols(child_att, parent_att) ON true JOIN pg_attribute a ON a.attrelid = child.oid AND a.attnum = cols.child_att JOIN pg_attribute pa ON pa.attrelid = parent.oid AND pa.attnum = cols.parent_att WHERE con.contype = 'f'"

function quotes(body) {
  const out = []
  const re = /'((?:[^']|'')*)'/g
  let match = re.exec(body)
  while (match) {
    out.push(match[1].split("''").join("'"))
    match = re.exec(body)
  }
  return out
}

function bareConstraint(body) {
  return body.replace(/'(?:[^']|'')*'/g, "''")
}

function mentionsColumn(def, column) {
  const escaped = column.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const ident = new RegExp('(?:^|[^A-Za-z0-9_])' + escaped + '(?:[^A-Za-z0-9_]|$)')
  return ident.test(bareConstraint(def))
}

function allowedLiterals(def, column) {
  if (!mentionsColumn(def, column)) {
    return null
  }
  const array = /ANY\s*\(\s*ARRAY\[([^\]]*)\]/i.exec(def)
  if (array) {
    const found = quotes(array[1])
    return found.length > 0 ? found : null
  }
  const listed = /\bIN\s*\(([^)]*)\)/i.exec(def)
  if (listed) {
    const found = quotes(listed[1])
    return found.length > 0 ? found : null
  }
  return null
}

const PINNED = {
  content: 'sample message',
  role: 'user',
  slug: 'sample-topic',
  session_key: 'sample-session',
  title: 'Sample Topic',
  agent: 'sample-agent',
  channel: 'sample-channel',
}

let uuidN = 0

function nextUuid() {
  uuidN += 1
  return '11111111-1111-4111-8111-' + uuidN.toString(16).padStart(12, '0')
}

function literalFor(column) {
  if (!column.notnull) {
    return null
  }
  const type = String(column.type)
  const lower = type.toLowerCase()
  if (lower === 'uuid') {
    return sqlText(nextUuid()) + '::uuid'
  }
  if (lower === 'boolean' || lower === 'bool') {
    return 'true'
  }
  if (lower === 'json' || lower === 'jsonb') {
    return `'{"k":"v"}'::${type}`
  }
  if (lower.endsWith('[]')) {
    if (lower === 'text[]' || lower.startsWith('character varying') || lower.startsWith('varchar')) {
      return `ARRAY['alpha','beta']::${type}`
    }
    return `'{}'::${type}`
  }
  if (lower.includes('timestamp') || lower === 'date') {
    return `'2024-01-02 03:04:05+00'::${type}`
  }
  if (lower === 'bytea') {
    return `'\\x01'::bytea`
  }
  if (lower.startsWith('halfvec') || lower.startsWith('vector')) {
    if (!column.notnull) {
      return null
    }
    const dim = Number((/\((\d+)\)/.exec(lower) || [])[1] || '1')
    const body = Array(dim).fill('0').join(',')
    return `'[${body}]'::${type}`
  }
  if (
    lower === 'double precision' ||
    lower === 'real' ||
    lower.startsWith('numeric') ||
    lower === 'integer' ||
    lower === 'bigint' ||
    lower === 'smallint' ||
    lower === 'int' ||
    lower === 'int2' ||
    lower === 'int4' ||
    lower === 'int8'
  ) {
    return `1::${type}`
  }
  if (lower === 'tsvector') {
    return "to_tsvector('english', 'sample')"
  }
  if (PINNED[column.name]) {
    return sqlText(PINNED[column.name]) + '::' + type
  }
  return sqlText('sample') + '::' + type
}

function valueExpr(column, fk, inserted, checks) {
  if (fk) {
    if (fk.parentSchema === column.schema && fk.parentTable === column.table) {
      if (column.notnull) {
        throw new Error('self foreign key is not null: ' + column.schema + '.' + column.table + '.' + column.name)
      }
      return null
    }
    const parent = inserted.get(tableId(fk.parentSchema, fk.parentTable))
    if (!parent || parent[fk.parentCol] == null) {
      if (!column.notnull) {
        return null
      }
      throw new Error('missing parent for ' + column.schema + '.' + column.table + '.' + column.name)
    }
    return sqlText(parent[fk.parentCol]) + '::' + column.type
  }
  const allowed = []
  for (const def of checks) {
    const found = allowedLiterals(def, column.name)
    if (found) {
      allowed.push(...found)
    }
  }
  if (allowed.length > 0) {
    const pinned = PINNED[column.name]
    const pick = pinned && allowed.includes(pinned) ? pinned : allowed[0]
    return sqlText(pick) + '::' + column.type
  }
  return literalFor(column)
}

async function openDb(dataDir, pgliteEntry, vectorEntry, trgmEntry) {
  const pglite = await import(pathToFileURL(pgliteEntry).href)
  const PGlite = pglite.PGlite
  const extensions = {}
  if (vectorEntry) {
    const mod = await import(pathToFileURL(vectorEntry).href)
    extensions.vector = mod.vector
  }
  if (trgmEntry) {
    const mod = await import(pathToFileURL(trgmEntry).href)
    extensions.pg_trgm = mod.pg_trgm
  }
  const href = pathToFileURL(dataDir).href
  const options = {}
  if (extensions.vector || extensions.pg_trgm) {
    options.extensions = extensions
  }
  if (typeof PGlite.create === 'function') {
    return PGlite.create(href, options)
  }
  return new PGlite(href, options)
}

async function loadColumns(pg, schema, name) {
  const reg = quoteIdent(schema) + '.' + quoteIdent(name)
  const columnRows = rowsOf(await pg.query(COLUMN_SQL, [reg]))
  return columnRows.map((column) => ({
    schema,
    table: name,
    name: String(column.name),
    type: column.type == null ? 'text' : String(column.type),
    notnull: isTrue(column.notnull),
    generated: isGenerated(column.generated),
    hasDefault: column.default_expr != null && String(column.default_expr) !== '',
  }))
}

async function listTables(pg) {
  const listed = rowsOf(await pg.query(USER_TABLES))
  const tables = []
  for (const row of listed) {
    const schema = String(row.schema)
    const name = String(row.name)
    const columns = await loadColumns(pg, schema, name)
    tables.push({ schema, name, columns })
  }
  return tables
}

async function orderedTables(pg, tables) {
  const fkRows = rowsOf(await pg.query(FK_SQL))
  const edges = fkRows.map((row) => ({
    child: tableId(row.child_schema, row.child_name),
    parent: tableId(row.parent_schema, row.parent_name),
  }))
  const byId = new Map(tables.map((table) => [tableId(table.schema, table.name), table]))
  return orderTables([...byId.keys()], edges)
    .map((id) => byId.get(id))
    .filter((table) => table)
}

async function seed(pg, migrationsDir, manifestPath) {
  const names = readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort()
  await pg.exec(
    'CREATE TABLE IF NOT EXISTS _rivetos_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now(), checksum TEXT)',
  )
  for (const name of names) {
    const sql = readFileSync(join(migrationsDir, name), 'utf8')
    await pg.exec('BEGIN')
    await pg.exec(sql)
    await pg.query('INSERT INTO _rivetos_migrations (name) VALUES ($1)', [name])
    await pg.exec('COMMIT')
  }
  const tables = await listTables(pg)
  const ordered = await orderedTables(pg, tables)
  const fkRows = rowsOf(await pg.query(FK_SQL))
  const fks = new Map()
  for (const row of fkRows) {
    const id = tableId(row.child_schema, row.child_name)
    const list = fks.get(id) ?? []
    list.push({
      column: String(row.child_col),
      parentSchema: String(row.parent_schema),
      parentTable: String(row.parent_name),
      parentCol: String(row.parent_col),
    })
    fks.set(id, list)
  }
  const inserted = new Map()
  for (const table of ordered) {
    if (table.name === '_rivetos_migrations') {
      continue
    }
    const reg = quoteIdent(table.schema) + '.' + quoteIdent(table.name)
    const checkRows = rowsOf(
      await pg.query(
        "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'c'",
        [reg],
      ),
    )
    const checks = checkRows.map((row) => String(row.def))
    const tableFks = fks.get(tableId(table.schema, table.name)) ?? []
    const names = []
    const exprs = []
    for (const column of table.columns) {
      if (column.generated) {
        continue
      }
      const fk = tableFks.find((item) => item.column === column.name)
      const expr = valueExpr(
        column,
        fk
          ? {
              parentSchema: fk.parentSchema,
              parentTable: fk.parentTable,
              parentCol: fk.parentCol,
            }
          : null,
        inserted,
        checks,
      )
      if (expr == null) {
        continue
      }
      names.push(quoteIdent(column.name))
      exprs.push(expr)
    }
    if (names.length === 0) {
      throw new Error('no columns to seed for ' + table.schema + '.' + table.name)
    }
    const insertSql = 'INSERT INTO ' + reg + ' (' + names.join(', ') + ') VALUES (' + exprs.join(', ') + ')'
    await pg.exec('BEGIN')
    await pg.exec('ALTER TABLE ' + reg + ' DISABLE TRIGGER USER')
    try {
      await pg.exec(insertSql)
    } catch (error) {
      throw new Error(insertSql + '\n' + (error && error.stack ? error.stack : String(error)))
    }
    await pg.exec('COMMIT')
    const selectList = table.columns
      .filter((column) => !column.generated)
      .map((column) => quoteIdent(column.name) + '::text AS ' + quoteIdent(column.name))
      .join(', ')
    const fetched = rowsOf(await pg.query('SELECT ' + selectList + ' FROM ' + reg))
    const sample = {}
    const row = fetched[0] || {}
    for (const column of table.columns) {
      if (column.generated) {
        continue
      }
      const value = row[column.name]
      sample[column.name] = value == null ? null : String(value)
    }
    inserted.set(tableId(table.schema, table.name), sample)
  }
  const manifest = { tables: {} }
  for (const table of ordered) {
    const qual = quoteIdent(table.schema) + '.' + quoteIdent(table.name)
    const counted = rowsOf(await pg.query('SELECT count(*)::bigint AS n FROM ' + qual))
    const key = table.schema + '.' + table.name
    manifest.tables[key] = {
      schema: table.schema,
      name: table.name,
      count: counted[0] ? String(counted[0].n) : '0',
      sample: inserted.get(tableId(table.schema, table.name)) || {},
    }
  }
  mkdirSync(dirname(manifestPath), { recursive: true })
  writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 })
}

async function exportRows(pg, stream) {
  const tables = await listTables(pg)
  const ordered = await orderedTables(pg, tables)
  for (const table of ordered) {
    const insertCols = table.columns.filter((column) => !column.generated)
    const qual = quoteIdent(table.schema) + '.' + quoteIdent(table.name)
    const counted = rowsOf(await pg.query('SELECT count(*)::bigint AS n FROM ' + qual))
    const countText = counted[0] ? String(counted[0].n) : '0'
    await writeLine(stream, { op: 'begin' })
    if (insertCols.length > 0) {
      const selectList = insertCols
        .map((column) => quoteIdent(column.name) + '::text AS ' + quoteIdent(column.name))
        .join(', ')
      const limit = 100
      let cursor = '(0,0)'
      for (;;) {
        const page = rowsOf(
          await pg.query(
            'SELECT ctid::text AS __cursor, ' +
              selectList +
              ' FROM ' +
              qual +
              ' WHERE ctid > $1::tid ORDER BY ctid LIMIT ' +
              String(limit),
            [cursor],
          ),
        )
        if (page.length === 0) {
          break
        }
        await writeLine(stream, {
          op: 'insert',
          schema: table.schema,
          table: table.name,
          columns: insertCols.map((column) => column.name),
          rows: page.map((row) => insertCols.map((column) => encodeText(row[column.name]))),
        })
        cursor = String(page[page.length - 1].__cursor)
        if (page.length < limit) {
          break
        }
      }
    }
    await writeLine(stream, {
      op: 'count',
      schema: table.schema,
      table: table.name,
      n: countText,
    })
    await writeLine(stream, { op: 'commit' })
  }
  const sequences = rowsOf(
    await pg.query(
      "SELECT schemaname AS schema, sequencename AS name, last_value AS last FROM pg_sequences WHERE schemaname <> 'pg_catalog' AND schemaname <> 'information_schema'",
    ),
  )
  for (const row of sequences) {
    const called = row.last != null
    const last = called ? String(row.last) : '1'
    await writeLine(stream, {
      op: 'setval',
      schema: String(row.schema),
      name: String(row.name),
      last,
      called,
    })
  }
  await writeLine(stream, { op: 'done' })
}

const seeding = process.argv.includes('--seed')
const dataDir = required('--data-dir')
const pgliteEntry = required('--pglite')
const vectorEntry = take('--vector')
const trgmEntry = take('--trgm')
const outPath = seeding ? '' : required('--out')
const migrationsDir = seeding ? required('--migrations') : ''
const manifestPath = seeding ? required('--manifest') : ''

let pg
let stream
try {
  mkdirSync(dataDir, { recursive: true })
  pg = await openDb(dataDir, pgliteEntry, vectorEntry, trgmEntry)
  if (seeding) {
    await seed(pg, migrationsDir, manifestPath)
  } else {
    mkdirSync(dirname(outPath), { recursive: true })
    stream = createWriteStream(outPath, { mode: 0o600 })
    await exportRows(pg, stream)
    await new Promise((resolve, reject) => {
      stream.end((error) => (error ? reject(error) : resolve()))
    })
  }
} catch (error) {
  console.error(error && error.stack ? error.stack : String(error))
  process.exitCode = 1
} finally {
  if (pg && typeof pg.close === 'function') {
    try {
      await pg.close()
    } catch (error) {
      console.error(error && error.stack ? error.stack : String(error))
      process.exitCode = 1
    }
  }
}
