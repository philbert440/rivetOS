package io.rivethub.app.plane

// Shared value type; no Compose dependency in plane logic.
data class SelectOption(val value: String, val label: String, val enabled: Boolean = true, val helper: String? = null)
