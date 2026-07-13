package dev.rivet.app.data.datastore

import androidx.compose.material3.Text
import dev.rivet.ai.provider.Modality
import dev.rivet.ai.provider.Model
import dev.rivet.ai.provider.ModelAbility
import dev.rivet.ai.provider.ProviderSetting
import kotlin.uuid.Uuid

// Kept stable: PreferencesStore falls back to this id for chat/title/translate/etc.
val DEFAULT_AUTO_MODEL_ID = Uuid.parse("b7055fb4-39f9-4042-a88a-0d80ed76cf08")
// rivet-grok's stable model id (rivet-claude reuses DEFAULT_AUTO_MODEL_ID above). Used to tag
// CLI turns synced back into a thread with the correct agent.
val RIVET_GROK_MODEL_ID = Uuid.parse("a1b2c3d4-0002-4002-8002-000000000002")

// The Rivet agent-session provider (stable id). Chat requests through this provider get
// `x-rivet-conversation` headers so the backend maps them to one persistent agent session.
// Its baseUrl is repointed when the user switches nodes (local bridge ↔ remote den `/v1`);
// see [NodeChatBackend].
val RIVET_BRIDGE_PROVIDER_ID = Uuid.parse("a8d2d463-e8c0-41f2-b89e-f5eb8e716cce")

// Loopback bridge auth token + port. RivetRuntimeService writes this token into the
// rootfs token file before launch so the bridge accepts the provider's apiKey below.
// Loopback-only (127.0.0.1), so a fixed per-build token is acceptable.
const val RIVET_BRIDGE_TOKEN = "1fi9y47WZqA64RjU8L9ROWzL"
const val RIVET_BRIDGE_PORT = 8765

/** @see NodeChatBackend.isAgentSessionProvider */
fun isAgentSessionProvider(provider: dev.rivet.ai.provider.ProviderSetting?): Boolean =
    NodeChatBackend.isAgentSessionProvider(provider)

// Port for the app-managed dropbear SSH server (track B). Key-only auth (the rootfs
// ships ~/.ssh/authorized_keys), runs as the non-root `rivet` user under proot. Toggled
// from the drawer; supervised + wakelocked by RivetRuntimeService so it survives doze —
// the thing that kept killing the manual Termux sshd.
const val RIVET_SSH_PORT = 8022

/**
 * Rivet ships with ONE provider out of the box: the on-device bridge fronting the
 * subscription-authed Claude + Grok CLIs (loopback 127.0.0.1:8765). No third-party
 * gateways. Login is done once in the in-app terminal (`claude` / `grok`); then chat
 * just works.
 */
val DEFAULT_PROVIDERS = listOf(
    ProviderSetting.OpenAI(
        id = RIVET_BRIDGE_PROVIDER_ID,
        name = "Rivet",
        baseUrl = NodeChatBackend.LOCAL_BRIDGE_BASE_URL,
        apiKey = RIVET_BRIDGE_TOKEN,
        enabled = true,
        builtIn = true,
        description = {
            Text("On-device Claude + Grok via the Rivet bridge. Open the terminal and run `claude` / `grok` to log in, then chat.")
        },
        models = listOf(
            Model(
                id = DEFAULT_AUTO_MODEL_ID,
                modelId = "rivet-claude",
                displayName = "Claude",
                inputModalities = listOf(Modality.TEXT),
                outputModalities = listOf(Modality.TEXT),
                abilities = listOf(ModelAbility.TOOL, ModelAbility.REASONING),
            ),
            Model(
                id = RIVET_GROK_MODEL_ID,
                modelId = "rivet-grok",
                displayName = "Grok",
                inputModalities = listOf(Modality.TEXT),
                outputModalities = listOf(Modality.TEXT),
                abilities = listOf(ModelAbility.TOOL, ModelAbility.REASONING),
            ),
        )
    ),
)
