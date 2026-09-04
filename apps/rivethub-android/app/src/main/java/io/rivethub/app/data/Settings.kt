package io.rivethub.app.data

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.core.stringSetPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import io.rivethub.app.gateway.wireJson
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer

private val Context.store: DataStore<Preferences> by preferencesDataStore(name = "rivethub")

data class Prefs(
    val entryUrl: String = "",
    val extraNodes: Set<String> = emptySet(),
    val handle: String = "you",
    val strictHostnames: Boolean = true,
    val pinned: Set<String> = emptySet(),
    val hidden: Set<String> = emptySet(),
    val sessionOverrides: Map<String, String> = emptyMap(),
    val lastSeen: Map<String, Long> = emptyMap(),
    val onboarded: Boolean = false,
    val desktopUrl: String = "",
    val themeMode: String = "system",
    val sessionModes: Map<String, String> = emptyMap(),
    val archived: Set<String> = emptySet(),
    val titleOverrides: Map<String, String> = emptyMap(),
    val agentPointers: Map<String, String> = emptyMap(),
    val terminalFontSp: Int = 13,
    val viewNodeId: String = "",
    val currentAgentId: String = "",
    val agentsCollapsed: Boolean = false,
)

class Settings(context: Context) {
    private val ds = context.applicationContext.store

    val prefs: Flow<Prefs> = ds.data.map { p ->
        Prefs(
            entryUrl = p[ENTRY_URL] ?: "",
            extraNodes = p[EXTRA_NODES] ?: emptySet(),
            handle = p[HANDLE] ?: "you",
            strictHostnames = p[STRICT] ?: true,
            pinned = p[PINNED] ?: emptySet(),
            hidden = p[HIDDEN] ?: emptySet(),
            sessionOverrides = decodeMap(p[SESSIONS]),
            lastSeen = decodeLongMap(p[LAST_SEEN]),
            onboarded = p[ONBOARDED] ?: false,
            desktopUrl = p[DESKTOP_URL] ?: "",
            themeMode = p[THEME] ?: "system",
            sessionModes = decodeMap(p[SESSION_MODES]),
            archived = p[ARCHIVED] ?: emptySet(),
            titleOverrides = decodeMap(p[TITLES]),
            agentPointers = decodeMap(p[POINTERS]),
            terminalFontSp = p[TERM_FONT] ?: 13,
            viewNodeId = p[VIEW_NODE] ?: "",
            currentAgentId = p[CURRENT_AGENT] ?: "",
            agentsCollapsed = p[AGENTS_COLLAPSED] ?: false,
        )
    }

    suspend fun snapshot(): Prefs = prefs.first()

    suspend fun setEntryUrl(url: String) = ds.edit { it[ENTRY_URL] = url.trim().trimEnd('/') }
    suspend fun setStrictHostnames(v: Boolean) = ds.edit { it[STRICT] = v }
    suspend fun setOnboarded(v: Boolean) = ds.edit { it[ONBOARDED] = v }

    suspend fun addExtraNode(url: String) = ds.edit { it[EXTRA_NODES] = (it[EXTRA_NODES] ?: emptySet()) + url.trim().trimEnd('/') }
    suspend fun removeExtraNode(url: String) = ds.edit { it[EXTRA_NODES] = (it[EXTRA_NODES] ?: emptySet()) - url }

    suspend fun setThemeMode(mode: String) = ds.edit { it[THEME] = mode }
    suspend fun setTerminalFontSp(sp: Int) = ds.edit { it[TERM_FONT] = sp.coerceIn(10, 22) }
    suspend fun setViewNodeId(id: String) = ds.edit { it[VIEW_NODE] = id }
    suspend fun setCurrentAgentId(id: String) = ds.edit { it[CURRENT_AGENT] = id }
    suspend fun setAgentsCollapsed(v: Boolean) = ds.edit { it[AGENTS_COLLAPSED] = v }

    suspend fun setSessionMode(sessionId: String, mode: String) = ds.edit {
        it[SESSION_MODES] = encodeMap(decodeMap(it[SESSION_MODES]) + (sessionId to mode))
    }
    suspend fun rekeySessionMode(from: String, to: String) = ds.edit {
        val cur = decodeMap(it[SESSION_MODES])
        val moved = cur[from] ?: return@edit
        val next = if (cur[to] != null) cur - from else cur - from + (to to moved)
        it[SESSION_MODES] = encodeMap(next)
    }

    suspend fun setArchived(keys: Set<String>) = ds.edit { it[ARCHIVED] = keys }
    suspend fun archive(key: String) = ds.edit { it[ARCHIVED] = (it[ARCHIVED] ?: emptySet()) + key }
    suspend fun unarchive(key: String) = ds.edit { it[ARCHIVED] = (it[ARCHIVED] ?: emptySet()) - key }

    suspend fun setTitleOverride(key: String, title: String) = ds.edit {
        val cur = decodeMap(it[TITLES])
        val next = if (title.isBlank()) cur - key else cur + (key to title.trim())
        it[TITLES] = encodeMap(next)
    }

    suspend fun setAgentPointers(encoded: Map<String, String>) = ds.edit {
        it[POINTERS] = encodeMap(encoded)
    }

    suspend fun clearAll() = ds.edit { it.clear() }

    companion object {
        private val ENTRY_URL = stringPreferencesKey("entryUrl")
        private val EXTRA_NODES = stringSetPreferencesKey("extraNodes")
        private val HANDLE = stringPreferencesKey("handle")
        private val STRICT = booleanPreferencesKey("strictHostnames")
        private val PINNED = stringSetPreferencesKey("pinned")
        private val HIDDEN = stringSetPreferencesKey("hidden")
        private val SESSIONS = stringPreferencesKey("sessionOverrides")
        private val LAST_SEEN = stringPreferencesKey("lastSeen")
        private val ONBOARDED = booleanPreferencesKey("onboarded")
        private val DESKTOP_URL = stringPreferencesKey("desktopUrl")
        private val THEME = stringPreferencesKey("themeMode")
        private val SESSION_MODES = stringPreferencesKey("sessionModes")
        private val ARCHIVED = stringSetPreferencesKey("archived")
        private val TITLES = stringPreferencesKey("titleOverrides")
        private val POINTERS = stringPreferencesKey("agentPointers")
        private val TERM_FONT = intPreferencesKey("terminalFontSp")
        private val VIEW_NODE = stringPreferencesKey("viewNodeId")
        private val CURRENT_AGENT = stringPreferencesKey("currentAgentId")
        private val AGENTS_COLLAPSED = booleanPreferencesKey("agentsCollapsed")

        private val mapSer = MapSerializer(String.serializer(), String.serializer())
        private val longMapSer = MapSerializer(String.serializer(), Long.serializer())
        private fun decodeMap(s: String?): Map<String, String> =
            s?.let { runCatching { wireJson.decodeFromString(mapSer, it) }.getOrNull() } ?: emptyMap()
        private fun encodeMap(m: Map<String, String>): String = wireJson.encodeToString(mapSer, m)
        private fun decodeLongMap(s: String?): Map<String, Long> =
            s?.let { runCatching { wireJson.decodeFromString(longMapSer, it) }.getOrNull() } ?: emptyMap()
    }
}
