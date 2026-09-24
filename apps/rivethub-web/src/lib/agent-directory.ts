/**
 * Working-directory slug for the agent editor placeholder.
 *
 * Copied from `@rivetos/agent-registry`'s `slugify`
 * (`packages/agent-registry/src/validate.ts`). The hub must not depend on
 * that package — it pulls `pg`.
 *
 * Rule: lowercase, non-alnum runs become `-`, trim `-`, cap at 48, `'agent'`
 * when empty.
 */
const SLUG_MAX = 48

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/^-+|-+$/g, '')
  return slug.length > 0 ? slug : 'agent'
}

/** Placeholder `<directoryRoot>/<slug>`. No root yet → the slug alone. */
export function agentDirectoryPlaceholder(directoryRoot: string | undefined, name: string): string {
  const slug = slugify(name)
  const root = directoryRoot?.trim().replace(/\/+$/, '')
  return root ? `${root}/${slug}` : slug
}
