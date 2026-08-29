/**
 * Renderer reload policy. A dead renderer earns a reload only while the
 * consecutive-failure count is under the cap — and a did-finish-load alone
 * does NOT clear that count, or a renderer that finishes loading and then
 * dies (post-load script/preload crash) would re-arm the cap every cycle
 * and reload forever. A load counts as healthy only once the process has
 * SURVIVED for the healthy window after finishing.
 */

export const MAX_RENDERER_RELOADS = 3
export const RELOAD_HEALTHY_MS = 30_000

export class RendererReloadPolicy {
  private reloads = 0
  private lastFinishAt = 0

  constructor(
    private readonly max = MAX_RENDERER_RELOADS,
    private readonly healthyMs = RELOAD_HEALTHY_MS,
  ) {}

  /** Record a did-finish-load. Does not reset the failure count by itself. */
  finished(now: number): void {
    this.lastFinishAt = now
  }

  /** Decide for a dead renderer: true = reload it, false = crash loop —
   *  stop until a load survives the healthy window. `now` should come from
   *  the same monotonic clock as finished() — wall clock can jump forward
   *  and fake a healthy survival. */
  shouldReload(now: number): boolean {
    const lastFinish = this.lastFinishAt
    // A death ends the load that finish belonged to: consume the stamp, so
    // one finish justifies at most one reset and a reload that never
    // finishes can never inherit the previous load's "healthy" evidence.
    this.lastFinishAt = 0
    if (lastFinish !== 0 && now - lastFinish >= this.healthyMs) {
      // The previous load lived long enough to count as healthy — this
      // death starts a fresh streak instead of extending the old one.
      this.reloads = 0
    }
    if (this.reloads >= this.max) return false
    this.reloads += 1
    return true
  }
}
