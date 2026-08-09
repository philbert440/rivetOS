package dev.rivet.app.data.node

import android.content.Context
import android.content.SharedPreferences

/**
 * The on-device [NodeTokenStore]: one app-private prefs file, nothing else.
 *
 * A dedicated file rather than the settings DataStore, because the settings blob
 * is what the WebDAV/S3 backup uploads — a bearer in there would be synced off
 * the device. This file is additionally excluded from Android cloud backup and
 * device transfer (`res/xml/backup_rules.xml`, `res/xml/data_extraction_rules.xml`),
 * so the credential stays on the phone it was pasted into.
 *
 * Not encrypted, and that is a considered choice rather than an oversight: the
 * app already holds every provider API key and a Postgres URL with its password
 * in the plain app-private settings DataStore, so keystore-wrapping this one
 * value would buy nothing against the same attacker while adding a deprecated
 * dependency and a keystore failure mode. Encrypting the whole credential
 * surface at once is the honest follow-up, recorded in the plan doc.
 *
 * Never logged. No value from this file is written to logcat, analytics, or any
 * error string.
 */
class SharedPrefsNodeTokenStore(context: Context) : KeyedNodeTokenStore() {
    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    override fun read(key: String): String? = prefs.getString(key, null)

    override fun write(key: String, value: String, durable: Boolean) {
        val editor = prefs.edit().putString(key, value)
        // The acceptance bit is written once per credential, off the main
        // thread, and a crash inside apply()'s flush window would cost the
        // rotation-versus-rejection distinction — cheap enough to just commit.
        if (durable) editor.commit() else editor.apply()
    }

    override fun delete(vararg keys: String) {
        val editor = prefs.edit()
        keys.forEach { editor.remove(it) }
        editor.apply()
    }

    companion object {
        /** Matches the `path` in the backup exclusion rules — keep in sync. */
        const val FILE = "rivet_node_tokens"
    }
}
