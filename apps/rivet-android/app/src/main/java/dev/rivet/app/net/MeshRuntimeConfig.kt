package dev.rivet.app.net

import dev.rivet.app.data.datastore.MeshConfig

/**
 * Process-wide snapshot of [MeshConfig] for non-Compose consumers ([RivetVpn], the runtime's
 * baseEnv, status probes). Seeded and kept current by RivetHubApp collecting the settings flow.
 */
object MeshRuntimeConfig {
    @Volatile
    var current: MeshConfig = MeshConfig()
}
