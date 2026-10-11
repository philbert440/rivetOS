import { pathToFileURL } from 'node:url'
import { createWriteStream } from 'node:fs'
import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'

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

function encode(value, type) {
  if (value === null || value === undefined) {
    return null
  }
  const lower = String(type).toLowerCase()
  if (lower === 'bytea') {
    if (typeof value === 'string') {
      return { x: value.replace(/^\\x/, '') }
    }
    if (value instanceof Uint8Array) {
      return { x: Buffer.from(value).toString('hex') }
    }
  }
  if (lower === 'json' || lower === 'jsonb') {
    if (typeof value === 'string') {
      return { t: value }
    }
    return { j: value }
  }
  if (typeof value === 'boolean') {
    return { b: value }
  }
  if (typeof value === 'bigint') {
    return { t: value.toString() }
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return { t: String(value) }
    }
    return { t: JSON.stringify(value) }
  }
  if (typeof value === 'object') {
    return { j: value }
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

const dataDir = required('--data-dir')
const outPath = required('--out')
const pgliteEntry = required('--pglite')
const vectorEntry = take('--vector')
const trgmEntry = take('--trgm')

let pg
let stream
try {
  mkdirSync(dirname(outPath), { recursive: true })
  stream = createWriteStream(outPath, { mode: 0o600 })
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
  pg = typeof PGlite.create === 'function' ? await PGlite.create(href, options) : new PGlite(href, options)
  const extensionRows = rowsOf(
    await pg.query("SELECT extname AS name FROM pg_extension WHERE extname <> 'plpgsql' ORDER BY 1"),
  )
  for (const row of extensionRows) {
    await writeLine(stream, { op: 'extension', name: String(row.name) })
  }
  const listed = rowsOf(
    await pg.query(
      "SELECT n.nspname AS schema, c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind = 'r' AND n.nspname <> 'pg_catalog' AND n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg_%' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e') ORDER BY 1, 2",
    ),
  )
  const tables = []
  for (const row of listed) {
    const schema = String(row.schema)
    const name = String(row.name)
    const reg = quoteIdent(schema) + '.' + quoteIdent(name)
    const columnRows = rowsOf(
      await pg.query(
        'SELECT a.attname AS name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS notnull, a.attgenerated AS generated FROM pg_attribute a WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum',
        [reg],
      ),
    )
    const columns = columnRows.map((column) => ({
      name: String(column.name),
      type: column.type == null ? 'text' : String(column.type),
      nullable: column.notnull !== true && column.notnull !== 't',
      generated: column.generated != null && String(column.generated) !== '',
    }))
    const pkRows = rowsOf(
      await pg.query(
        'SELECT a.attname AS name FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey) WHERE i.indrelid = $1::regclass AND i.indisprimary ORDER BY array_position(i.indkey, a.attnum)',
        [reg],
      ),
    )
    tables.push({
      schema,
      name,
      columns,
      pk: pkRows.map((pk) => String(pk.name)),
    })
  }
  const schemas = []
  for (const table of tables) {
    if (!schemas.includes(table.schema)) {
      schemas.push(table.schema)
    }
  }
  for (const schema of schemas) {
    await writeLine(stream, { op: 'schema', name: schema })
  }
  const fkRows = rowsOf(
    await pg.query(
      "SELECT nchild.nspname AS child_schema, child.relname AS child_name, nparent.nspname AS parent_schema, parent.relname AS parent_name FROM pg_constraint con JOIN pg_class child ON child.oid = con.conrelid JOIN pg_namespace nchild ON nchild.oid = child.relnamespace JOIN pg_class parent ON parent.oid = con.confrelid JOIN pg_namespace nparent ON nparent.oid = parent.relnamespace WHERE con.contype = 'f'",
    ),
  )
  const edges = fkRows.map((row) => ({
    child: tableId(row.child_schema, row.child_name),
    parent: tableId(row.parent_schema, row.parent_name),
  }))
  const byId = new Map(tables.map((table) => [tableId(table.schema, table.name), table]))
  const orderedIds = orderTables([...byId.keys()], edges)
  for (const id of orderedIds) {
    const table = byId.get(id)
    if (!table) {
      continue
    }
    await writeLine(stream, {
      op: 'table',
      schema: table.schema,
      name: table.name,
      columns: table.columns.map((column) => ({
        name: column.name,
        type: column.type,
        nullable: column.nullable,
      })),
    })
    if (table.pk.length > 0) {
      await writeLine(stream, {
        op: 'pk',
        schema: table.schema,
        table: table.name,
        columns: table.pk,
      })
    }
  }
  for (const id of orderedIds) {
    const table = byId.get(id)
    if (!table) {
      continue
    }
    const insertCols = table.columns.filter((column) => !column.generated)
    const qual = quoteIdent(table.schema) + '.' + quoteIdent(table.name)
    const counted = rowsOf(
      await pg.query('SELECT count(*)::bigint AS n FROM ' + qual),
    )
    const countText = counted[0] ? String(counted[0].n) : '0'
    await writeLine(stream, { op: 'begin' })
    if (insertCols.length > 0) {
      const selectList = insertCols.map((column) => quoteIdent(column.name)).join(', ')
      const limit = 100
      let offset = 0
      for (;;) {
        const page = rowsOf(
          await pg.query(
            'SELECT ' + selectList + ' FROM ' + qual + ' ORDER BY ctid LIMIT ' + String(limit) + ' OFFSET ' + String(offset),
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
          types: insertCols.map((column) => column.type),
          rows: page.map((row) => insertCols.map((column) => encode(row[column.name], column.type))),
        })
        offset += page.length
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
  const fkDefs = rowsOf(
    await pg.query(
      "SELECT n.nspname AS schema, c.relname AS name, pg_get_constraintdef(con.oid) AS def FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE con.contype = 'f' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = con.oid AND d.deptype = 'e')",
    ),
  )
  for (const row of fkDefs) {
    await writeLine(stream, {
      op: 'sql',
      sql: 'ALTER TABLE ' + quoteIdent(String(row.schema)) + '.' + quoteIdent(String(row.name)) + ' ADD ' + String(row.def),
    })
  }
  const indexes = rowsOf(
    await pg.query(
      "SELECT pg_get_indexdef(i.indexrelid) AS def FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE NOT i.indisprimary AND n.nspname <> 'pg_catalog' AND n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg_%' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = i.indexrelid AND d.deptype = 'e')",
    ),
  )
  for (const row of indexes) {
    await writeLine(stream, { op: 'sql', sql: String(row.def) })
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
  await new Promise((resolve, reject) => {
    stream.end((error) => (error ? reject(error) : resolve()))
  })
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
