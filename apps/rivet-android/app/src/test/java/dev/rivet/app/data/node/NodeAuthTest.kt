package dev.rivet.app.data.node

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The rotation story. A 401 is not one condition: with no bearer it means the
 * node started gating, with an unproven bearer it means the paste was wrong, and
 * with a bearer this node has already accepted it means the node rotated. Those
 * are three different sentences to a human and one identical degrade underneath.
 */
class NodeAuthStatesTest {
    private fun probe(
        hadToken: Boolean,
        outcome: NodeAuthOutcome,
        denUrl: String = "http://node-a:5174",
    ) = NodeAuthProbe(denUrl = denUrl, hadToken = hadToken, outcome = outcome)

    @Test
    fun `an answered read is ok`() {
        val next = NodeAuthStates.next(
            previous = NodeAuthState.NEEDS_TOKEN,
            probe = probe(hadToken = true, outcome = NodeAuthOutcome.AUTHORIZED),
            everAuthorized = false,
        )

        assertEquals(NodeAuthState.OK, next)
    }

    @Test
    fun `401 with no token means the node needs one`() {
        val next = NodeAuthStates.next(
            previous = NodeAuthState.UNKNOWN,
            probe = probe(hadToken = false, outcome = NodeAuthOutcome.UNAUTHORIZED),
            everAuthorized = false,
        )

        assertEquals(NodeAuthState.NEEDS_TOKEN, next)
    }

    @Test
    fun `401 with a never-accepted token means rejected`() {
        val next = NodeAuthStates.next(
            previous = NodeAuthState.UNKNOWN,
            probe = probe(hadToken = true, outcome = NodeAuthOutcome.UNAUTHORIZED),
            everAuthorized = false,
        )

        assertEquals(NodeAuthState.TOKEN_REJECTED, next)
    }

    @Test
    fun `401 after this token worked once means the node rotated it`() {
        val next = NodeAuthStates.next(
            previous = NodeAuthState.UNKNOWN,
            probe = probe(hadToken = true, outcome = NodeAuthOutcome.UNAUTHORIZED),
            everAuthorized = true,
        )

        assertEquals(NodeAuthState.STALE_TOKEN, next)
    }

    @Test
    fun `401 straight after an ok read means rotated even without stored history`() {
        // Rotation inside one app run: the acceptance bit may not have been
        // written yet, but the previous state already says this worked.
        val next = NodeAuthStates.next(
            previous = NodeAuthState.OK,
            probe = probe(hadToken = true, outcome = NodeAuthOutcome.UNAUTHORIZED),
            everAuthorized = false,
        )

        assertEquals(NodeAuthState.STALE_TOKEN, next)
    }

    @Test
    fun `an unreachable node never downgrades a known state`() {
        for (previous in NodeAuthState.entries) {
            val next = NodeAuthStates.next(
                previous = previous,
                probe = probe(hadToken = true, outcome = NodeAuthOutcome.INDETERMINATE),
                everAuthorized = true,
            )
            assertEquals(previous, next)
        }
    }

    @Test
    fun `only the three failure states ask for attention`() {
        assertTrue(NodeAuthState.NEEDS_TOKEN.needsAttention)
        assertTrue(NodeAuthState.TOKEN_REJECTED.needsAttention)
        assertTrue(NodeAuthState.STALE_TOKEN.needsAttention)
        assertFalse(NodeAuthState.OK.needsAttention)
        assertFalse(NodeAuthState.UNKNOWN.needsAttention)
    }
}

class NodeAuthRegistryTest {
    private val tokens = InMemoryNodeTokenStore()
    private val registry = NodeAuthRegistry(tokens)

    private val node = "http://node-a:5174"

    @Test
    fun `unseen node is unknown`() {
        assertEquals(NodeAuthState.UNKNOWN, registry.state(node))
    }

    @Test
    fun `state is keyed by normalized url`() {
        registry.record(NodeAuthProbe("$node/", hadToken = false, NodeAuthOutcome.UNAUTHORIZED))

        assertEquals(NodeAuthState.NEEDS_TOKEN, registry.state(node))
        assertEquals(NodeAuthState.NEEDS_TOKEN, registry.state("  $node  "))
    }

    @Test
    fun `an accepted bearer is remembered across the process`() {
        tokens.put(node, "aaa")
        registry.record(NodeAuthProbe(node, hadToken = true, NodeAuthOutcome.AUTHORIZED))

        assertTrue(tokens.wasAuthorized(node))

        // Fresh registry = app restart. The bit lives in the store, so a 401 now
        // still reads as a rotation rather than a bad paste.
        val restarted = NodeAuthRegistry(tokens)
        restarted.record(NodeAuthProbe(node, hadToken = true, NodeAuthOutcome.UNAUTHORIZED))

        assertEquals(NodeAuthState.STALE_TOKEN, restarted.state(node))
    }

    @Test
    fun `a tokenless success never marks a credential as accepted`() {
        registry.record(NodeAuthProbe(node, hadToken = false, NodeAuthOutcome.AUTHORIZED))

        assertEquals(NodeAuthState.OK, registry.state(node))
        assertFalse(tokens.wasAuthorized(node))
    }

    @Test
    fun `pasting a new token after a rotation clears the stale verdict`() {
        tokens.put(node, "aaa")
        registry.record(NodeAuthProbe(node, hadToken = true, NodeAuthOutcome.AUTHORIZED))
        registry.record(NodeAuthProbe(node, hadToken = true, NodeAuthOutcome.UNAUTHORIZED))
        assertEquals(NodeAuthState.STALE_TOKEN, registry.state(node))

        tokens.put(node, "bbb")
        registry.forget(node)

        assertEquals(NodeAuthState.UNKNOWN, registry.state(node))
        assertFalse(tokens.wasAuthorized(node))

        registry.record(NodeAuthProbe(node, hadToken = true, NodeAuthOutcome.AUTHORIZED))
        assertEquals(NodeAuthState.OK, registry.state(node))
    }

    @Test
    fun `nodes do not share a verdict`() {
        val other = "http://node-b:5174"
        registry.record(NodeAuthProbe(node, hadToken = false, NodeAuthOutcome.UNAUTHORIZED))
        registry.record(NodeAuthProbe(other, hadToken = false, NodeAuthOutcome.AUTHORIZED))

        assertEquals(NodeAuthState.NEEDS_TOKEN, registry.state(node))
        assertEquals(NodeAuthState.OK, registry.state(other))
    }
}
