# @rivetos/rivet-bots-android

**Rivet Bots** — a Grok Bot-style Android client for the Rivet mesh where every
bot is an agent running on a mesh node. Jetpack Compose, Kotlin, **Apache-2.0**.
Written new; not a fork of `apps/rivet-android` (AGPL RikkaHub) and shares no
source with it.

Home is the synced bot list (pinned faces up top, threads by recency, swipe to
pin/hide). Tap a bot for its thread; the header's monitor button opens the
bot's **Computer** — a native render of that session's den room (activity,
tool, thought, plan, terminal). Profile shows node/provider/model.

## How a bot maps to the mesh

| Grok Bot        | Rivet Bots                                                                 |
|-----------------|----------------------------------------------------------------------------|
| Bot             | `(agent, node)` from the entry node's `GET /api/mesh` + `GET /api/catalog/agents` |
| Conversation    | one gateway session per bot: `POST /api/sessions/:id/messages {text, userId, agent}` |
| Live typing     | `WS /api/sessions/ws?session=` frames (`message` / `stream` text·reasoning·tool_*·done) |
| Computer        | `GET /api/events/state?session=` + `WS /api/events/ws?session=` (den `RoomState`) |
| Sign in         | device PKCS#12 from `rivet-ca.sh issue-client <id>` (gateway auth is mTLS-only) |

Session ids are deterministic per device+bot (`rivetbots-<tag>-<node>-<agent>`)
so a reinstall picks the thread back up; "New conversation" appends a stamp.

## Build

Needs Android SDK 37 + JDK 17+. Toolchain is pinned to what the fleet build host
already caches (AGP 9.2.1, Kotlin 2.3.21, Gradle 9.4.1).

    ./gradlew :app:assembleDebug
    # → app/build/outputs/apk/debug/app-debug.apk

Repo CI does not compile Android; build locally (see AGENT.md for the pve3 recipe).

## First run

1. Issue a device cert on the CA host: `scripts/rivet-ca.sh issue-client <device-id>`,
   export a `.p12` (with the CA chain), copy it to the phone.
2. Open the app → **Join mesh →** → entry node `https://<node>:5174`, pick the `.p12`,
   passphrase → **Connect**.

No mesh addresses, certs or tokens are baked into the APK.
