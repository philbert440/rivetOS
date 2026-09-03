package io.rivethub.app.data

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.core.stringSetPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
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
    val botEdits: Map<String, BotEdit> = emptyMap(),
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
            botEdits = decodeEdits(p[BOT_EDITS]),
        )
    }

    suspend fun snapshot(): Prefs = prefs.first()

    suspend fun setEntryUrl(url: String) = ds.edit { it[ENTRY_URL] = url.trim().trimEnd('/') }
    suspend fun setHandle(h: String) = ds.edit { it[HANDLE] = h.trim().ifBlank { "you" } }
    suspend fun setStrictHostnames(v: Boolean) = ds.edit { it[STRICT] = v }
    suspend fun setOnboarded(v: Boolean) = ds.edit { it[ONBOARDED] = v }

    suspend fun addExtraNode(url: String) = ds.edit { it[EXTRA_NODES] = (it[EXTRA_NODES] ?: emptySet()) + url.trim().trimEnd('/') }
    suspend fun removeExtraNode(url: String) = ds.edit { it[EXTRA_NODES] = (it[EXTRA_NODES] ?: emptySet()) - url }

    suspend fun togglePin(botId: String) = ds.edit {
        val cur = it[PINNED] ?: emptySet()
        it[PINNED] = if (botId in cur) cur - botId else cur + botId
    }
    suspend fun setHidden(botId: String, hidden: Boolean) = ds.edit {
        val cur = it[HIDDEN] ?: emptySet()
        it[HIDDEN] = if (hidden) cur + botId else cur - botId
    }
    suspend fun unhideAll() = ds.edit { it[HIDDEN] = emptySet() }

    suspend fun setSessionOverride(botId: String, sessionId: String) = ds.edit {
        it[SESSIONS] = encodeMap(decodeMap(it[SESSIONS]) + (botId to sessionId))
    }
    suspend fun markSeen(botId: String, ts: Long) = ds.edit {
        val cur = decodeLongMap(it[LAST_SEEN])
        if ((cur[botId] ?: 0L) < ts) it[LAST_SEEN] = encodeLongMap(cur + (botId to ts))
    }

    suspend fun setDesktopUrl(url: String) = ds.edit { it[DESKTOP_URL] = url.trim() }

    suspend fun setBotEdit(botId: String, edit: BotEdit) = ds.edit {
        it[BOT_EDITS] = encodeEdits(decodeEdits(it[BOT_EDITS]) + (botId to edit))
    }
    suspend fun clearBotEdit(botId: String) = ds.edit {
        it[BOT_EDITS] = encodeEdits(decodeEdits(it[BOT_EDITS]) - botId)
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
        private val BOT_EDITS = stringPreferencesKey("botEdits")

        private val mapSer = MapSerializer(String.serializer(), String.serializer())
        private val longMapSer = MapSerializer(String.serializer(), Long.serializer())
        private val editMapSer = MapSerializer(String.serializer(), BotEdit.serializer())
        private fun decodeMap(s: String?): Map<String, String> =
            s?.let { runCatching { wireJson.decodeFromString(mapSer, it) }.getOrNull() } ?: emptyMap()
        private fun encodeMap(m: Map<String, String>): String = wireJson.encodeToString(mapSer, m)
        private fun decodeLongMap(s: String?): Map<String, Long> =
            s?.let { runCatching { wireJson.decodeFromString(longMapSer, it) }.getOrNull() } ?: emptyMap()
        private fun encodeLongMap(m: Map<String, Long>): String = wireJson.encodeToString(longMapSer, m)
        private fun decodeEdits(s: String?): Map<String, BotEdit> =
            s?.let { runCatching { wireJson.decodeFromString(editMapSer, it) }.getOrNull() } ?: emptyMap()
        private fun encodeEdits(m: Map<String, BotEdit>): String = wireJson.encodeToString(editMapSer, m)
    }
}
