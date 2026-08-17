/** OpenMausBot analytics surface — no PostHog, no OMB telemetry. */

export function initAnalytics(): void {}

export function track(_event: string, _props?: Record<string, unknown>): void {}

export function emailGateDone(): boolean {
  return true;
}

export function setEmailGateDone(_status: "submitted" | "skipped"): void {}

export function identifyEmail(_email: string): void {}
