package io.rivethub.app.plane

/**
 * Settings tabs, in row order — the phone twin of rivethub-web
 * `lib/settings-tabs.ts`. The desktop's Keyboard tab (rebindable shortcuts)
 * has no phone counterpart; its Devices tab (pairing other devices) is this
 * phone's own identity here. An unknown id opens General.
 */
enum class SettingsTab(val id: String) {
    General("general"),
    Appearance("appearance"),
    Node("node"),
    Device("device"),
    Advanced("advanced"),
}

val DEFAULT_SETTINGS_TAB: SettingsTab = SettingsTab.General

fun settingsTab(id: String?): SettingsTab =
    SettingsTab.entries.firstOrNull { it.id == id } ?: DEFAULT_SETTINGS_TAB
