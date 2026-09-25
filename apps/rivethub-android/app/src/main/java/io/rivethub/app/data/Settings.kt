package io.rivethub.app.data

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.floatPreferencesKey
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.core.stringSetPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import io.rivethub.app.gateway.wireJson
import io.rivethub.app.plane.migrateLocalPrefs
import io.rivethub.app.plane.nearestFontScale
import io.rivethub.app.plane.toggleFavourite
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
    val fontScale: Float = 1.0f,
    val sessionModes: Map<String, String> = emptyMap(),
    val archived: Set<String> = emptySet(),
    val titleOverrides: Map<String, String> = emptyMap(),
    val agentPointers: Map<String, String> = emptyMap(),
    val terminalFontSp: Int = 13,
    val viewNodeId: String = "",
    val currentAgentId: String = "",
    val agentsCollapsed: Boolean = false,
    /** Instant-resume pointer (2026-09-04: home is the chat surface, not the
     *  list) — the last opened session's key + its node's den URL. Drafts are
     *  never written (they are in-memory only). */
    val lastSessionKey: String = "",
    val lastSessionNode: String = "",
    /** Unfinished drawer sections — off by default. Memory is not experimental. */
    val expFiles: Boolean = false,
    val expTasks: Boolean = false,
    val expWorkflows: Boolean = false,
    val codeLineNumbers: Boolean = false,
    val codeWrap: Boolean = false,
    /** Composer model sheet favourites (model ids), shown as the first group. */
    val favouriteModels: Set<String> = emptySet(),
    /** Post an OS notification when a task completes while the app is in the background. Off by default. */
    val taskNotifications: Boolean = false,
    /** Chat message display (UX-SPEC §7): token stats under assistant turns, action row always shown. */
    val showStats: Boolean = false,
    val actionRowAlways: Boolean = false,
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
            fontScale = nearestFontScale(p[FONT_SCALE] ?: 1.0f),
            sessionModes = decodeMap(p[SESSION_MODES]),
            archived = p[ARCHIVED] ?: emptySet(),
            titleOverrides = decodeMap(p[TITLES]),
            agentPointers = decodeMap(p[POINTERS]),
            terminalFontSp = p[TERM_FONT] ?: 13,
            viewNodeId = p[VIEW_NODE] ?: "",
            currentAgentId = p[CURRENT_AGENT] ?: "",
            agentsCollapsed = p[AGENTS_COLLAPSED] ?: false,
            lastSessionKey = p[LAST_SESSION_KEY] ?: "",
            lastSessionNode = p[LAST_SESSION_NODE] ?: "",
            expFiles = p[EXP_FILES] ?: false,
            expTasks = p[EXP_TASKS] ?: false,
            expWorkflows = p[EXP_WORKFLOWS] ?: false,
            codeLineNumbers = p[CODE_LINE_NUMBERS] ?: false,
            codeWrap = p[CODE_WRAP] ?: false,
            favouriteModels = p[FAVOURITE_MODELS] ?: emptySet(),
            taskNotifications = p[TASK_NOTIFICATIONS] ?: false,
            showStats = p[SHOW_STATS] ?: false,
            actionRowAlways = p[ACTION_ROW_ALWAYS] ?: false,
        )
    }

    suspend fun snapshot(): Prefs = prefs.first()

    suspend fun setEntryUrl(url: String) = ds.edit { it[ENTRY_URL] = url.trim().trimEnd('/') }
    suspend fun setStrictHostnames(v: Boolean) = ds.edit { it[STRICT] = v }
    suspend fun setOnboarded(v: Boolean) = ds.edit { it[ONBOARDED] = v }

    suspend fun addExtraNode(url: String) = ds.edit { it[EXTRA_NODES] = (it[EXTRA_NODES] ?: emptySet()) + url.trim().trimEnd('/') }
    suspend fun removeExtraNode(url: String) = ds.edit { it[EXTRA_NODES] = (it[EXTRA_NODES] ?: emptySet()) - url }

    suspend fun setFontScale(v: Float) = ds.edit { it[FONT_SCALE] = nearestFontScale(v) }
    suspend fun setThemeMode(mode: String) = ds.edit { it[THEME] = mode }
    suspend fun setCodeLineNumbers(v: Boolean) = ds.edit { it[CODE_LINE_NUMBERS] = v }
    suspend fun setCodeWrap(v: Boolean) = ds.edit { it[CODE_WRAP] = v }
    suspend fun setExpFiles(v: Boolean) = ds.edit { it[EXP_FILES] = v }
    suspend fun setExpTasks(v: Boolean) = ds.edit { it[EXP_TASKS] = v }
    suspend fun setExpWorkflows(v: Boolean) = ds.edit { it[EXP_WORKFLOWS] = v }
    suspend fun setTaskNotifications(v: Boolean) = ds.edit { it[TASK_NOTIFICATIONS] = v }
    suspend fun setShowStats(v: Boolean) = ds.edit { it[SHOW_STATS] = v }
    suspend fun setActionRowAlways(v: Boolean) = ds.edit { it[ACTION_ROW_ALWAYS] = v }
    suspend fun setTerminalFontSp(sp: Int) = ds.edit { it[TERM_FONT] = sp.coerceIn(10, 22) }
    suspend fun setViewNodeId(id: String) = ds.edit { it[VIEW_NODE] = id }
    suspend fun setCurrentAgentId(id: String) = ds.edit { it[CURRENT_AGENT] = id }
    suspend fun setAgentsCollapsed(v: Boolean) = ds.edit { it[AGENTS_COLLAPSED] = v }
    /**
     * Add / remove [id] from the favourites inside ONE DataStore transaction
     * (like [archive]), so overlapping long-presses serialise instead of
     * overwriting each other. Returns the committed set.
     */
    suspend fun toggleFavouriteModel(id: String): Set<String> =
        ds.edit { it[FAVOURITE_MODELS] = toggleFavourite(it[FAVOURITE_MODELS] ?: emptySet(), id) }[FAVOURITE_MODELS]
            ?: emptySet()

    /** The instant-resume pointer — written on every chat open (see
     *  MainActivity openChat); read once at nav init. */
    suspend fun setLastSession(key: String, nodeDenUrl: String) = ds.edit {
        it[LAST_SESSION_KEY] = key
        it[LAST_SESSION_NODE] = nodeDenUrl.trim().trimEnd('/')
    }
    suspend fun clearLastSession() = ds.edit {
        it.remove(LAST_SESSION_KEY)
        it.remove(LAST_SESSION_NODE)
    }

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

    /** Local-only list chrome (UX-SPEC §2): pin floats a row into the Pinned
     *  section; hide drops it from the list. Neither touches the den. */
    suspend fun pin(key: String) = ds.edit { it[PINNED] = (it[PINNED] ?: emptySet()) + key }
    suspend fun unpin(key: String) = ds.edit { it[PINNED] = (it[PINNED] ?: emptySet()) - key }
    suspend fun hide(key: String) = ds.edit { it[HIDDEN] = (it[HIDDEN] ?: emptySet()) + key }
    suspend fun unhide(key: String) = ds.edit { it[HIDDEN] = (it[HIDDEN] ?: emptySet()) - key }

    /** A session key moved (draft adopted, id rotated): carry its pin and
     *  hide marks from [from] to [to] in ONE edit, so no reader ever sees one
     *  set migrated and the other not (plane/ConversationIdentity.kt). */
    suspend fun migrateKeys(from: String, to: String) = ds.edit {
        val pinned = it[PINNED] ?: emptySet()
        val hidden = it[HIDDEN] ?: emptySet()
        val (nextPinned, nextHidden) = migrateLocalPrefs(pinned, hidden, from, to)
        if (nextPinned != pinned) it[PINNED] = nextPinned
        if (nextHidden != hidden) it[HIDDEN] = nextHidden
    }

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
        private val FONT_SCALE = floatPreferencesKey("fontScale")
        private val THEME = stringPreferencesKey("themeMode")
        private val SESSION_MODES = stringPreferencesKey("sessionModes")
        private val ARCHIVED = stringSetPreferencesKey("archived")
        private val TITLES = stringPreferencesKey("titleOverrides")
        private val POINTERS = stringPreferencesKey("agentPointers")
        private val TERM_FONT = intPreferencesKey("terminalFontSp")
        private val VIEW_NODE = stringPreferencesKey("viewNodeId")
        private val CURRENT_AGENT = stringPreferencesKey("currentAgentId")
        private val AGENTS_COLLAPSED = booleanPreferencesKey("agentsCollapsed")
        private val LAST_SESSION_KEY = stringPreferencesKey("lastSessionKey")
        private val LAST_SESSION_NODE = stringPreferencesKey("lastSessionNode")
        private val CODE_LINE_NUMBERS = booleanPreferencesKey("codeLineNumbers")
        private val CODE_WRAP = booleanPreferencesKey("codeWrap")
        private val EXP_FILES = booleanPreferencesKey("expFiles")
        private val EXP_TASKS = booleanPreferencesKey("expTasks")
        private val EXP_WORKFLOWS = booleanPreferencesKey("expWorkflows")
        private val FAVOURITE_MODELS = stringSetPreferencesKey("favouriteModels")
        private val TASK_NOTIFICATIONS = booleanPreferencesKey("taskNotifications")
        private val SHOW_STATS = booleanPreferencesKey("showStats")
        private val ACTION_ROW_ALWAYS = booleanPreferencesKey("actionRowAlways")

        private val mapSer = MapSerializer(String.serializer(), String.serializer())
        private val longMapSer = MapSerializer(String.serializer(), Long.serializer())
        private fun decodeMap(s: String?): Map<String, String> =
            s?.let { runCatching { wireJson.decodeFromString(mapSer, it) }.getOrNull() } ?: emptyMap()
        private fun encodeMap(m: Map<String, String>): String = wireJson.encodeToString(mapSer, m)
        private fun decodeLongMap(s: String?): Map<String, Long> =
            s?.let { runCatching { wireJson.decodeFromString(longMapSer, it) }.getOrNull() } ?: emptyMap()
    }
}
