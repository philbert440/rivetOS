/**
 * Domain constants — runtime values that belong in core, not in types.
 * Types package is interfaces only.
 */

import type { SilentResponse } from '@rivetos/types';

/** Response strings the runtime should swallow (not send to channel). */
export const SILENT_RESPONSES: readonly SilentResponse[] = ['NO_REPLY', 'HEARTBEAT_OK'];
