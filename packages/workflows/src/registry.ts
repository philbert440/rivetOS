/**
 * Namespaced call registry — the universal joint between workflows and work units.
 *
 * - bare ref (`pr-review`) → native workflow (child run dir, full tree/resume)
 * - `ext:deploy-service` → foreign work unit via a registered resolver
 * - unknown namespace → error listing known namespaces
 */

import { UnknownCallNamespaceError } from './errors.js'

export interface CallContext {
  /** Parent run id. */
  parentRunId: string
  /** Parent step id making the call. */
  parentStepId: string
  /** Parent caseDir — children nest underneath. */
  parentCaseDir: string
  /** Timeout hint (ms). */
  timeoutMs?: number
}

export interface CallResolver {
  /**
   * Resolve and execute a namespaced (or bare, for native) call.
   * @param name - ref without namespace prefix (e.g. "deploy-service" for ext:deploy-service)
   * @param input - seed fields for the child
   * @param ctx - parent provenance
   */
  resolve(name: string, input: Record<string, unknown>, ctx: CallContext): Promise<unknown>
}

export interface CallRegistry {
  register(namespace: string, resolver: CallResolver): void
  /** Known namespaces (including '' for bare/native). */
  namespaces(): string[]
  call(ref: string, input: Record<string, unknown>, ctx: CallContext): Promise<unknown>
}

/** Parse `namespace:name` or bare `name`. Bare → namespace "". */
export function parseCallRef(ref: string): { namespace: string; name: string } {
  const idx = ref.indexOf(':')
  if (idx === -1) return { namespace: '', name: ref }
  return { namespace: ref.slice(0, idx), name: ref.slice(idx + 1) }
}

export class NamespacedCallRegistry implements CallRegistry {
  private readonly resolvers = new Map<string, CallResolver>()

  register(namespace: string, resolver: CallResolver): void {
    this.resolvers.set(namespace, resolver)
  }

  namespaces(): string[] {
    return [...this.resolvers.keys()].map((k) => (k === '' ? '(native)' : k))
  }

  async call(ref: string, input: Record<string, unknown>, ctx: CallContext): Promise<unknown> {
    const { namespace, name } = parseCallRef(ref)
    const resolver = this.resolvers.get(namespace)
    if (!resolver) {
      const known = [...this.resolvers.keys()].map((k) => (k === '' ? '(native/bare)' : k))
      throw new UnknownCallNamespaceError(ref, namespace || '(empty)', known)
    }
    return resolver.resolve(name, input, ctx)
  }
}

/** Create a registry with optional native resolver under bare namespace. */
export function createCallRegistry(native?: CallResolver): NamespacedCallRegistry {
  const reg = new NamespacedCallRegistry()
  if (native) {
    reg.register('', native)
  }
  return reg
}
