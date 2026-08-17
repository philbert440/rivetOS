import type { Bot } from '@/state/store'

/** Webhook ingress is not on the team gateway yet. Schedules are live. */
export function WebhooksPanel({ bots: _bots }: { bots: Bot[] }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-8">
      <div className="max-w-[420px] text-center">
        <h2 className="text-[18px] font-semibold text-ink">Webhooks next</h2>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-secondary">
          Event-triggered automations wait on the rivet-team gateway. Use Schedules for timed work now.
        </p>
      </div>
    </div>
  )
}
