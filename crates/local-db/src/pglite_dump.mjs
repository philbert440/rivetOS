import { pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

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

const dataDir = required('--data-dir')
const outPath = required('--out')
const countsPath = required('--counts')
const pgliteEntry = required('--pglite')
const toolsEntry = required('--tools')
const vectorEntry = take('--vector')
const trgmEntry = take('--trgm')

let pg
try {
  const pglite = await import(pathToFileURL(pgliteEntry).href)
  const tools = await import(pathToFileURL(toolsEntry).href)
  const PGlite = pglite.PGlite
  const pgDump = tools.pgDump
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
  const listed = await pg.query(
    "SELECT n.nspname AS schema, c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind = 'r' AND n.nspname <> 'pg_catalog' AND n.nspname <> 'information_schema' ORDER BY 1, 2",
  )
  const counts = {}
  for (const row of listed.rows) {
    const schema = String(row.schema)
    const name = String(row.name)
    const counted = await pg.query(
      'SELECT count(*)::bigint AS n FROM ' + quoteIdent(schema) + '.' + quoteIdent(name),
    )
    counts[schema + '.' + name] = Number(counted.rows[0].n)
  }
  const dumped = await pgDump({
    pg,
    args: ['--inserts', '--no-owner', '--no-privileges', '-U', 'postgres'],
  })
  const sql = typeof dumped === 'string' ? dumped : await dumped.text()
  mkdirSync(dirname(outPath), { recursive: true })
  mkdirSync(dirname(countsPath), { recursive: true })
  writeFileSync(outPath, sql, { mode: 0o600 })
  writeFileSync(countsPath, JSON.stringify(counts), { mode: 0o600 })
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
