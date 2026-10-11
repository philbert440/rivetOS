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
  await seedWorkerQueue(pg)
  await seedHierarchies(pg)
  const recounted = await listTables(pg)
  const manifest = { tables: {}, links: {} }
  for (const table of recounted) {
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
  const taskLinks = rowsOf(
    await pg.query('SELECT count(*)::bigint AS n FROM public.ros_tasks WHERE parent_task_id IS NOT NULL'),
  )
  const summaryLinks = rowsOf(
    await pg.query('SELECT count(*)::bigint AS n FROM public.ros_summaries WHERE parent_id IS NOT NULL'),
  )
  manifest.links.ros_tasks = taskLinks[0] ? String(taskLinks[0].n) : '0'
  manifest.links.ros_summaries = summaryLinks[0] ? String(summaryLinks[0].n) : '0'
  mkdirSync(dirname(manifestPath), { recursive: true })
  writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 })
}

function fixedUuid(prefix, n) {
  return prefix + n.toString(16).padStart(12, '0')
}

function sqlNumber(value) {
  const text = String(value)
  if (!/^-?[0-9]+$/.test(text)) {
    throw new Error('sequence value is not an integer: ' + text)
  }
  return text
}

function oneStatement(sql) {
  const trimmed = String(sql).trim()
  if (trimmed.endsWith(';')) {
    return trimmed.slice(0, -1).trim()
  }
  return trimmed
}

function qualifyType(typeSchema, formatted) {
  const typeName = formatted == null ? 'text' : String(formatted)
  if (!typeSchema || typeSchema === 'pg_catalog' || typeSchema === 'public' || typeName.includes('.')) {
    return typeName
  }
  const match = /^([A-Za-z_][A-Za-z0-9_]*)(.*)$/.exec(typeName)
  if (!match) {
    return quoteIdent(typeSchema) + '.' + typeName
  }
  return quoteIdent(typeSchema) + '.' + match[1] + match[2]
}

function isExportedSchema(schema) {
  return schema !== 'public' && schema !== 'information_schema' && !String(schema).startsWith('pg_')
}

async function seedWorkerQueue(pg) {
  await pg.exec(
    'CREATE SCHEMA graphile_worker;' +
      "CREATE TYPE graphile_worker.job_state AS ENUM ('created', 'running');" +
      'CREATE TABLE graphile_worker._private_job_queues (' +
      'id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY, ' +
      'queue_name text NOT NULL UNIQUE);' +
      'CREATE TABLE graphile_worker._private_tasks (' +
      'id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY, ' +
      'identifier text NOT NULL UNIQUE);' +
      'CREATE TABLE graphile_worker._private_jobs (' +
      'id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY, ' +
      'task_id integer NOT NULL REFERENCES graphile_worker._private_tasks (id), ' +
      "state graphile_worker.job_state NOT NULL DEFAULT 'created', " +
      'payload json NOT NULL);' +
      'CREATE INDEX jobs_state ON graphile_worker._private_jobs (state);' +
      'CREATE FUNCTION graphile_worker.job_count() RETURNS bigint LANGUAGE sql STABLE AS $$ SELECT count(*)::bigint FROM graphile_worker._private_jobs $$;' +
      'CREATE VIEW graphile_worker.jobs AS SELECT id, payload, state FROM graphile_worker._private_jobs;',
  )
  await pg.query(
    'INSERT INTO graphile_worker._private_tasks (identifier) VALUES ($1) ON CONFLICT (identifier) DO UPDATE SET identifier = EXCLUDED.identifier',
    ['extract-wiki'],
  )
  await pg.query(
    'INSERT INTO graphile_worker._private_jobs (task_id, payload) SELECT id, $1::json FROM graphile_worker._private_tasks WHERE identifier = $2',
    ['{"task":"extract-wiki"}', 'extract-wiki'],
  )
}

async function seedHierarchies(pg) {
  const taskParent = fixedUuid('22222222-2222-4222-8222-', 1)
  const taskChild = fixedUuid('22222222-2222-4222-8222-', 2)
  const summaryParent = fixedUuid('33333333-3333-4333-8333-', 1)
  await withUserTriggersDisabled(pg, 'public.ros_tasks', async () => {
    await pg.query(
      'INSERT INTO public.ros_tasks (id, goal, executor, agent_id, origin) VALUES ($1::uuid, $2, $3, $4, $5)',
      [taskParent, 'parent goal', 'chat-loop', 'sample-agent', 'chat'],
    )
    await pg.query(
      'INSERT INTO public.ros_tasks (id, goal, executor, agent_id, origin, parent_task_id) VALUES ($1::uuid, $2, $3, $4, $5, $6::uuid)',
      [taskChild, 'child goal', 'chat-loop', 'sample-agent', 'chat', taskParent],
    )
    await pg.query("UPDATE public.ros_tasks SET status = 'running' WHERE id = $1::uuid", [taskParent])
  })
  const taskOrder = rowsOf(
    await pg.query(
      'SELECT CASE WHEN p.ctid > c.ctid THEN \'t\' ELSE \'f\' END AS ok FROM public.ros_tasks p JOIN public.ros_tasks c ON c.parent_task_id = p.id WHERE p.id = $1::uuid',
      [taskParent],
    ),
  )
  if (!taskOrder[0] || String(taskOrder[0].ok) !== 't') {
    throw new Error('ros_tasks parent ctid is not after its child')
  }
  const childValues = []
  const childParams = []
  for (let index = 0; index < 100; index += 1) {
    childParams.push(fixedUuid('33333333-3333-4333-8333-', index + 2))
    childValues.push('($' + String(childParams.length) + '::uuid, $' + String(childParams.length + 1) + '::uuid, $' + String(childParams.length + 2) + ')')
    childParams.push(summaryParent)
    childParams.push('child summary ' + String(index))
  }
  await withUserTriggersDisabled(pg, 'public.ros_summaries', async () => {
    await pg.query(
      'INSERT INTO public.ros_summaries (id, content) VALUES ($1::uuid, $2)',
      [summaryParent, 'parent summary'],
    )
    await pg.query(
      'INSERT INTO public.ros_summaries (id, parent_id, content) VALUES ' + childValues.join(', '),
      childParams,
    )
    await pg.query('UPDATE public.ros_summaries SET content = content || $1 WHERE id = $2::uuid', [
      ' moved',
      summaryParent,
    ])
  })
  const summaryOrder = rowsOf(
    await pg.query(
      'SELECT CASE WHEN p.ctid > ALL (SELECT c.ctid FROM public.ros_summaries c WHERE c.id <> p.id) THEN \'t\' ELSE \'f\' END AS ok FROM public.ros_summaries p WHERE p.id = $1::uuid',
      [summaryParent],
    ),
  )
  if (!summaryOrder[0] || String(summaryOrder[0].ok) !== 't') {
    throw new Error('ros_summaries parent ctid is not last')
  }
}

async function withUserTriggersDisabled(pg, reg, body) {
  await pg.exec('BEGIN')
  try {
    await pg.exec('ALTER TABLE ' + reg + ' DISABLE TRIGGER USER')
    await body()
    await pg.exec('COMMIT')
  } catch (error) {
    try {
      await pg.exec('ROLLBACK')
    } catch (rollbackError) {
      console.error(rollbackError && rollbackError.stack ? rollbackError.stack : String(rollbackError))
    }
    throw error
  }
}

async function exportSchemas(pg, stream) {
  const listed = rowsOf(
    await pg.query(
      "SELECT nspname AS name FROM pg_namespace WHERE nspname <> 'information_schema' AND nspname NOT LIKE 'pg_%' ORDER BY nspname",
    ),
  )
  for (const row of listed) {
    const schema = String(row.name)
    if (!isExportedSchema(schema)) {
      continue
    }
    await writeLine(stream, { op: 'begin' })
    await writeLine(stream, { op: 'ddl', sql: 'CREATE SCHEMA ' + quoteIdent(schema) })
    await writeLine(stream, {
      op: 'ddl',
      sql: 'SET LOCAL search_path TO ' + quoteIdent(schema) + ', public',
    })
    const statements = await schemaDdl(pg, schema)
    for (const sql of statements) {
      await writeLine(stream, { op: 'ddl', sql })
    }
    await writeLine(stream, { op: 'commit' })
  }
}

async function schemaDdl(pg, schema) {
  const unsupported = rowsOf(
    await pg.query(
      "SELECT c.relkind::text AS kind, c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind IN ('m', 'f', 'p') ORDER BY c.relname",
      [schema],
    ),
  )
  if (unsupported.length > 0) {
    throw new Error(
      'unsupported relation ' + schema + '.' + String(unsupported[0].name) + ' kind ' + String(unsupported[0].kind),
    )
  }
  const oddConstraints = rowsOf(
    await pg.query(
      "SELECT con.contype::text AS kind, c.relname AS name FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND con.contype NOT IN ('p', 'u', 'c', 'f', 'x', 'n') ORDER BY c.relname",
      [schema],
    ),
  )
  if (oddConstraints.length > 0) {
    throw new Error(
      'unsupported constraint type ' + String(oddConstraints[0].kind) + ' on ' + schema + '.' + String(oddConstraints[0].name),
    )
  }
  const statements = []
  statements.push(...(await enumStatements(pg, schema)))
  statements.push(...(await compositeStatements(pg, schema)))
  statements.push(...(await domainStatements(pg, schema)))
  const sequences = await sequencePlans(pg, schema)
  for (const sequence of sequences) {
    statements.push(sequence.createSql)
  }
  const tables = await tablePlans(pg, schema)
  for (const table of tables) {
    statements.push(table.createSql)
  }
  for (const sequence of sequences) {
    if (sequence.ownedSql) {
      statements.push(sequence.ownedSql)
    }
  }
  statements.push(...(await constraintStatements(pg, schema)))
  statements.push(...(await indexStatements(pg, schema)))
  statements.push(...(await functionStatements(pg, schema)))
  statements.push(...(await viewStatements(pg, schema)))
  statements.push(...(await triggerStatements(pg, schema)))
  return statements
}

async function enumStatements(pg, schema) {
  const rows = rowsOf(
    await pg.query(
      "SELECT t.typname AS name, e.enumlabel AS label FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace JOIN pg_enum e ON e.enumtypid = t.oid WHERE n.nspname = $1 AND t.typtype = 'e' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = t.oid AND d.deptype = 'e') ORDER BY t.typname, e.enumsortorder",
      [schema],
    ),
  )
  const grouped = new Map()
  for (const row of rows) {
    const name = String(row.name)
    const labels = grouped.get(name) ?? []
    labels.push(sqlText(String(row.label)))
    grouped.set(name, labels)
  }
  const statements = []
  for (const [name, labels] of grouped) {
    statements.push('CREATE TYPE ' + quoteIdent(schema) + '.' + quoteIdent(name) + ' AS ENUM (' + labels.join(', ') + ')')
  }
  return statements
}

async function compositeStatements(pg, schema) {
  const rows = rowsOf(
    await pg.query(
      "SELECT t.typname AS name, a.attname AS column_name, tn.nspname AS type_schema, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace JOIN pg_class c ON c.oid = t.typrelid AND c.relkind = 'c' JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped JOIN pg_type bt ON bt.oid = a.atttypid JOIN pg_namespace tn ON tn.oid = bt.typnamespace WHERE n.nspname = $1 AND t.typtype = 'c' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = t.oid AND d.deptype = 'e') ORDER BY t.typname, a.attnum",
      [schema],
    ),
  )
  const grouped = new Map()
  for (const row of rows) {
    const name = String(row.name)
    const columns = grouped.get(name) ?? []
    columns.push(quoteIdent(String(row.column_name)) + ' ' + qualifyType(row.type_schema, row.type))
    grouped.set(name, columns)
  }
  const statements = []
  for (const [name, columns] of grouped) {
    statements.push(
      'CREATE TYPE ' + quoteIdent(schema) + '.' + quoteIdent(name) + ' AS (' + columns.join(', ') + ')',
    )
  }
  return statements
}

async function domainStatements(pg, schema) {
  const rows = rowsOf(
    await pg.query(
      "SELECT t.oid::text AS oid, t.typname AS name, tn.nspname AS type_schema, pg_catalog.format_type(t.typbasetype, t.typtypmod) AS base, CASE WHEN t.typnotnull THEN 't' ELSE 'f' END AS notnull, t.typdefault AS default_expr FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace JOIN pg_type bt ON bt.oid = t.typbasetype JOIN pg_namespace tn ON tn.oid = bt.typnamespace WHERE n.nspname = $1 AND t.typtype = 'd' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = t.oid AND d.deptype = 'e') ORDER BY t.typname",
      [schema],
    ),
  )
  const statements = []
  for (const row of rows) {
    let sql =
      'CREATE DOMAIN ' +
      quoteIdent(schema) +
      '.' +
      quoteIdent(String(row.name)) +
      ' AS ' +
      qualifyType(row.type_schema, row.base)
    if (row.default_expr != null && String(row.default_expr) !== '') {
      sql += ' DEFAULT ' + String(row.default_expr)
    }
    if (isTrue(row.notnull)) {
      sql += ' NOT NULL'
    }
    statements.push(sql)
    const checks = rowsOf(
      await pg.query(
        "SELECT conname AS name, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE contypid = $1::oid AND contype = 'c' ORDER BY conname",
        [String(row.oid)],
      ),
    )
    for (const check of checks) {
      statements.push(
        'ALTER DOMAIN ' +
          quoteIdent(schema) +
          '.' +
          quoteIdent(String(row.name)) +
          ' ADD CONSTRAINT ' +
          quoteIdent(String(check.name)) +
          ' ' +
          oneStatement(check.def),
      )
    }
  }
  return statements
}

async function sequencePlans(pg, schema) {
  const rows = rowsOf(
    await pg.query(
      "SELECT c.relname AS name, s.seqstart::text AS seqstart, s.seqincrement::text AS seqincrement, s.seqmin::text AS seqmin, s.seqmax::text AS seqmax, s.seqcache::text AS seqcache, CASE WHEN s.seqcycle THEN 't' ELSE 'f' END AS seqcycle FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_sequence s ON s.seqrelid = c.oid WHERE n.nspname = $1 AND c.relkind = 'S' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e') AND NOT EXISTS (SELECT 1 FROM pg_depend d JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid WHERE d.objid = c.oid AND a.attidentity IN ('a', 'd')) ORDER BY c.relname",
      [schema],
    ),
  )
  const owned = rowsOf(
    await pg.query(
      "SELECT seq.relname AS seq, tab.relname AS table_name, a.attname AS column_name FROM pg_class seq JOIN pg_namespace n ON n.oid = seq.relnamespace JOIN pg_depend d ON d.objid = seq.oid AND d.deptype IN ('a', 'i') JOIN pg_class tab ON tab.oid = d.refobjid JOIN pg_namespace tn ON tn.oid = tab.relnamespace JOIN pg_attribute a ON a.attrelid = tab.oid AND a.attnum = d.refobjsubid WHERE n.nspname = $1 AND seq.relkind = 'S' AND a.attidentity NOT IN ('a', 'd') AND NOT EXISTS (SELECT 1 FROM pg_depend ext WHERE ext.objid = seq.oid AND ext.deptype = 'e')",
      [schema],
    ),
  )
  const ownedBy = new Map(owned.map((row) => [String(row.seq), row]))
  return rows.map((row) => {
    const name = String(row.name)
    const cycle = isTrue(row.seqcycle) ? ' CYCLE' : ' NO CYCLE'
    const createSql =
      'CREATE SEQUENCE ' +
      quoteIdent(schema) +
      '.' +
      quoteIdent(name) +
      ' START WITH ' +
      sqlNumber(row.seqstart) +
      ' INCREMENT BY ' +
      sqlNumber(row.seqincrement) +
      ' MINVALUE ' +
      sqlNumber(row.seqmin) +
      ' MAXVALUE ' +
      sqlNumber(row.seqmax) +
      ' CACHE ' +
      sqlNumber(row.seqcache) +
      cycle
    const owner = ownedBy.get(name)
    let ownedSql = ''
    if (owner && String(owner.table_name)) {
      ownedSql =
        'ALTER SEQUENCE ' +
        quoteIdent(schema) +
        '.' +
        quoteIdent(name) +
        ' OWNED BY ' +
        quoteIdent(schema) +
        '.' +
        quoteIdent(String(owner.table_name)) +
        '.' +
        quoteIdent(String(owner.column_name))
    }
    return { createSql, ownedSql }
  })
}

async function tablePlans(pg, schema) {
  const tables = rowsOf(
    await pg.query(
      "SELECT c.oid::text AS oid, c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind = 'r' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e') ORDER BY c.relname",
      [schema],
    ),
  )
  const plans = []
  for (const table of tables) {
    const columns = rowsOf(
      await pg.query(
        'SELECT a.attname AS name, tn.nspname AS type_schema, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type, CASE WHEN a.attnotnull THEN \'t\' ELSE \'f\' END AS notnull, a.attidentity AS identity, a.attgenerated AS generated, pg_get_expr(ad.adbin, ad.adrelid) AS expr FROM pg_attribute a JOIN pg_type bt ON bt.oid = a.atttypid JOIN pg_namespace tn ON tn.oid = bt.typnamespace LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum WHERE a.attrelid = $1::oid AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum',
        [String(table.oid)],
      ),
    )
    if (columns.length === 0) {
      throw new Error('no columns to declare for ' + schema + '.' + String(table.name))
    }
    const clauses = columns.map((column) => columnClause(column))
    plans.push({
      createSql:
        'CREATE TABLE ' +
        quoteIdent(schema) +
        '.' +
        quoteIdent(String(table.name)) +
        ' (' +
        clauses.join(', ') +
        ')',
    })
  }
  return plans
}

function columnClause(column) {
  const identity = column.identity == null ? '' : String(column.identity).trim()
  const generated = isGenerated(column.generated)
  let clause = quoteIdent(String(column.name)) + ' ' + qualifyType(column.type_schema, column.type)
  if (identity === 'a') {
    clause += ' GENERATED ALWAYS AS IDENTITY'
  } else if (identity === 'd') {
    clause += ' GENERATED BY DEFAULT AS IDENTITY'
  } else if (generated) {
    if (column.expr == null || String(column.expr) === '') {
      throw new Error('generated column has no expression: ' + String(column.name))
    }
    clause += ' GENERATED ALWAYS AS (' + String(column.expr) + ') STORED'
  } else if (column.expr != null && String(column.expr) !== '') {
    clause += ' DEFAULT ' + String(column.expr)
  }
  if (isTrue(column.notnull)) {
    clause += ' NOT NULL'
  }
  return clause
}

async function constraintStatements(pg, schema) {
  const rows = rowsOf(
    await pg.query(
      "SELECT c.relname AS table_name, con.conname AS name, con.contype::text AS kind, pg_get_constraintdef(con.oid) AS def FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND con.contype IN ('p', 'u', 'c', 'f', 'x') ORDER BY c.relname, con.conname",
      [schema],
    ),
  )
  const rank = { p: 0, u: 1, c: 2, f: 3, x: 4 }
  rows.sort((left, right) => {
    const delta = (rank[String(left.kind)] ?? 9) - (rank[String(right.kind)] ?? 9)
    if (delta !== 0) {
      return delta
    }
    return String(left.table_name).localeCompare(String(right.table_name)) || String(left.name).localeCompare(String(right.name))
  })
  return rows.map(
    (row) =>
      'ALTER TABLE ' +
      quoteIdent(schema) +
      '.' +
      quoteIdent(String(row.table_name)) +
      ' ADD CONSTRAINT ' +
      quoteIdent(String(row.name)) +
      ' ' +
      oneStatement(row.def),
  )
}

async function indexStatements(pg, schema) {
  const rows = rowsOf(
    await pg.query(
      'SELECT pg_get_indexdef(i.indexrelid) AS def FROM pg_index i JOIN pg_class t ON t.oid = i.indrelid JOIN pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = $1 AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = i.indexrelid) ORDER BY t.relname, i.indexrelid',
      [schema],
    ),
  )
  return rows.map((row) => oneStatement(row.def))
}

async function functionStatements(pg, schema) {
  const rows = rowsOf(
    await pg.query(
      "SELECT p.oid::text AS oid, l.lanname AS lang, pg_get_functiondef(p.oid) AS def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang WHERE n.nspname = $1 AND p.prokind = 'f' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e') ORDER BY p.oid",
      [schema],
    ),
  )
  for (const row of rows) {
    const lang = String(row.lang)
    if (lang === 'c' || lang === 'internal') {
      throw new Error('unsupported function language ' + lang + ' in ' + schema)
    }
  }
  const otherKinds = rowsOf(
    await pg.query(
      "SELECT p.prokind::text AS kind, p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND p.prokind <> 'f' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e') ORDER BY p.proname",
      [schema],
    ),
  )
  if (otherKinds.length > 0) {
    throw new Error(
      'unsupported routine ' + schema + '.' + String(otherKinds[0].name) + ' kind ' + String(otherKinds[0].kind),
    )
  }
  const deps = rowsOf(
    await pg.query(
      'SELECT p.oid::text AS child, ref.oid::text AS parent FROM pg_depend d JOIN pg_proc p ON p.oid = d.objid JOIN pg_proc ref ON ref.oid = d.refobjid JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_namespace rn ON rn.oid = ref.pronamespace WHERE n.nspname = $1 AND rn.nspname = $1 AND p.oid <> ref.oid',
      [schema],
    ),
  )
  const byId = new Map(rows.map((row) => [String(row.oid), oneStatement(row.def)]))
  const edges = deps.map((row) => ({ child: String(row.child), parent: String(row.parent) }))
  return orderTables([...byId.keys()], edges)
    .map((id) => byId.get(id))
    .filter((sql) => sql)
}

async function viewStatements(pg, schema) {
  const rows = rowsOf(
    await pg.query(
      "SELECT c.oid::text AS oid, c.relname AS name, pg_get_viewdef(c.oid, true) AS def FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind = 'v' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e') ORDER BY c.relname",
      [schema],
    ),
  )
  const deps = rowsOf(
    await pg.query(
      "SELECT c.oid::text AS child, ref.oid::text AS parent FROM pg_depend d JOIN pg_rewrite r ON r.oid = d.objid JOIN pg_class c ON c.oid = r.ev_class JOIN pg_class ref ON ref.oid = d.refobjid JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_namespace rn ON rn.oid = ref.relnamespace WHERE n.nspname = $1 AND rn.nspname = $1 AND c.relkind = 'v' AND ref.relkind = 'v' AND c.oid <> ref.oid",
      [schema],
    ),
  )
  const byId = new Map(
    rows.map((row) => [
      String(row.oid),
      'CREATE VIEW ' + quoteIdent(schema) + '.' + quoteIdent(String(row.name)) + ' AS ' + oneStatement(row.def),
    ]),
  )
  const edges = deps.map((row) => ({ child: String(row.child), parent: String(row.parent) }))
  return orderTables([...byId.keys()], edges)
    .map((id) => byId.get(id))
    .filter((sql) => sql)
}

async function triggerStatements(pg, schema) {
  const rows = rowsOf(
    await pg.query(
      'SELECT pg_get_triggerdef(t.oid) AS def FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND NOT t.tgisinternal ORDER BY c.relname, t.tgname',
      [schema],
    ),
  )
  return rows.map((row) => oneStatement(row.def))
}

async function exportRows(pg, stream) {
  await exportSchemas(pg, stream)
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
