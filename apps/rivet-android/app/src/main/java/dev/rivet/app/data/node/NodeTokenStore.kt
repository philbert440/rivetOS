package dev.rivet.app.data.node

import dev.rivet.app.data.datastore.NodeRosterDefaults

/**
 * Per-node gateway bearers, keyed by normalized den URL.
 *
 * Deliberately NOT a field on `RosterNode`. The whole `Settings` object — roster
 * included — is serialized into `settings.json` and uploaded by the WebDAV/S3
 * backup sync, so a bearer stored there would leave the device for a third-party
 * server on the next sync. RivetHub web draws exactly the same line: the roster
 * persists in localStorage, the tokens sit in a separate per-node-keyed slot
 * (`apps/rivethub-web/src/stores/connection.ts`). This is that split, in Kotlin.
 *
 * Also tracked here: whether a node ever accepted the stored bearer. That single
 * bit is what separates "the node rotated its token" from "this token was never
 * any good", which are different messages to a human even though both end at the
 * same paste field.
 */
interface NodeTokenStore {
    /** Stored bearer for this node, or null when none is set. */
    fun tokenFor(denUrl: String): String?

    /** Store a bearer; blank or null clears it. */
    fun put(denUrl: String, token: String?)

    /** Forget this node's bearer and its acceptance history. */
    fun remove(denUrl: String)

    /** True once the node accepted the currently stored bearer at least once. */
    fun wasAuthorized(denUrl: String): Boolean

    /** Record that the node accepted the currently stored bearer. */
    fun markAuthorized(denUrl: String)
}

/**
 * Everything about a [NodeTokenStore] except where the bytes land: key shape,
 * URL normalization, blank handling, and the reset of the acceptance bit when a
 * credential is replaced. Subclasses supply three raw operations, so this logic
 * is exercised by JVM tests against an in-memory map rather than mocked away.
 */
abstract class KeyedNodeTokenStore : NodeTokenStore {
    protected abstract fun read(key: String): String?

    /**
     * [durable] asks the backing store to flush before returning. Used for the
     * acceptance bit, whose loss silently downgrades a later rotation into
     * "rejected"; a lost token is self-evident and just gets pasted again.
     */
    protected abstract fun write(key: String, value: String, durable: Boolean)

    protected abstract fun delete(vararg keys: String)

    final override fun tokenFor(denUrl: String): String? =
        read(tokenKey(denUrl))?.trim()?.takeIf { it.isNotEmpty() }

    final override fun put(denUrl: String, token: String?) {
        val next = token?.trim().orEmpty()
        if (next.isEmpty()) {
            remove(denUrl)
            return
        }
        // A replacement credential is unproven until the node takes it, so the
        // acceptance bit resets. Without this, pasting a wrong token after a
        // working one would still read as "rotated", not "rejected".
        if (next != tokenFor(denUrl)) delete(authorizedKey(denUrl))
        write(tokenKey(denUrl), next, durable = false)
    }

    final override fun remove(denUrl: String) {
        delete(tokenKey(denUrl), authorizedKey(denUrl))
    }

    final override fun wasAuthorized(denUrl: String): Boolean =
        read(authorizedKey(denUrl)) == ACCEPTED

    final override fun markAuthorized(denUrl: String) {
        write(authorizedKey(denUrl), ACCEPTED, durable = true)
    }

    companion object {
        const val TOKEN_PREFIX = "node.token."
        const val AUTHORIZED_PREFIX = "node.accepted."
        private const val ACCEPTED = "1"

        fun tokenKey(denUrl: String): String =
            TOKEN_PREFIX + NodeRosterDefaults.normalizeDenUrl(denUrl)

        fun authorizedKey(denUrl: String): String =
            AUTHORIZED_PREFIX + NodeRosterDefaults.normalizeDenUrl(denUrl)
    }
}
