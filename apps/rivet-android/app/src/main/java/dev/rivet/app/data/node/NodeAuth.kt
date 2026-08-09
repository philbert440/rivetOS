package dev.rivet.app.data.node

import dev.rivet.app.data.datastore.NodeRosterDefaults
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/** What one control-plane read said about the credential this client sent. */
enum class NodeAuthOutcome {
    /** The node answered. Whatever we sent (including nothing) was enough. */
    AUTHORIZED,

    /** The node refused the request on auth grounds (401/403). */
    UNAUTHORIZED,

    /**
     * The read told us nothing about auth — unreachable, timed out, or a 404
     * from a node with no control plane at all. Never downgrades a known state.
     */
    INDETERMINATE,
}

/** Per-node credential health, as far as the last probe could tell. */
enum class NodeAuthState {
    UNKNOWN,
    OK,

    /** The node gates its gateway and this client has no bearer for it. */
    NEEDS_TOKEN,

    /** A bearer is stored, and this node has never accepted it. */
    TOKEN_REJECTED,

    /** A bearer that used to work stopped working — the node rotated it. */
    STALE_TOKEN,
    ;

    val needsAttention: Boolean
        get() = this == NEEDS_TOKEN || this == TOKEN_REJECTED || this == STALE_TOKEN
}

/** One observation: which node, whether we sent a bearer, and what came back. */
data class NodeAuthProbe(
    val denUrl: String,
    val hadToken: Boolean,
    val outcome: NodeAuthOutcome,
)

/**
 * The pure transition. Kept out of the registry so the interesting part — the
 * rotation-versus-rejection split — is testable without a store or a flow.
 */
object NodeAuthStates {
    fun next(
        previous: NodeAuthState,
        probe: NodeAuthProbe,
        everAuthorized: Boolean,
    ): NodeAuthState = when {
        probe.outcome == NodeAuthOutcome.AUTHORIZED -> NodeAuthState.OK
        // A dead network must not spell "your token is wrong" — a phone flaps
        // radios constantly and the last real answer is the better guess.
        probe.outcome == NodeAuthOutcome.INDETERMINATE -> previous
        !probe.hadToken -> NodeAuthState.NEEDS_TOKEN
        everAuthorized || previous == NodeAuthState.OK -> NodeAuthState.STALE_TOKEN
        else -> NodeAuthState.TOKEN_REJECTED
    }
}

/**
 * Live per-node auth state for the UI.
 *
 * Fed by the control-plane snapshot read, which runs on the drawer's poll, so a
 * node that starts gating (or rotates its bearer) surfaces within one poll
 * without anything having to fail in a chat thread first. Nothing here changes
 * how requests are made — the degrade to the legacy surface is unconditional
 * and unchanged; this only decides what a human is told about it.
 */
class NodeAuthRegistry(private val tokens: NodeTokenStore) {
    private val _states = MutableStateFlow<Map<String, NodeAuthState>>(emptyMap())
    val states: StateFlow<Map<String, NodeAuthState>> = _states.asStateFlow()

    fun state(denUrl: String): NodeAuthState =
        _states.value[NodeRosterDefaults.normalizeDenUrl(denUrl)] ?: NodeAuthState.UNKNOWN

    fun record(probe: NodeAuthProbe) {
        val key = NodeRosterDefaults.normalizeDenUrl(probe.denUrl)
        val next = NodeAuthStates.next(state(key), probe, tokens.wasAuthorized(key))
        // Only a bearer we actually sent can be marked as accepted; a tokenless
        // node answering 200 says nothing about a credential.
        if (probe.outcome == NodeAuthOutcome.AUTHORIZED && probe.hadToken) {
            tokens.markAuthorized(key)
        }
        _states.update { it + (key to next) }
    }

    /** Drop a node's state — it left the roster, or its credential changed. */
    fun forget(denUrl: String) {
        val key = NodeRosterDefaults.normalizeDenUrl(denUrl)
        _states.update { it - key }
    }
}
