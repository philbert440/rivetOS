<div align="center">
  <img src="docs/icon.png" alt="RivetHub" width="100" />
  <h1>RivetHub for Android</h1>

  <p>A self-contained RivetOS node in your pocket 🔩📱</p>
</div>

RivetHub is a native Android (Kotlin / Jetpack Compose) client for
[RivetOS](https://github.com/philbert440/rivetOS) — and more than a client: the app can
run a full Linux rootfs on-device (proot, no root required) hosting real agent
harnesses, drive the phone itself through an accessibility-based control service, and
join a RivetOS mesh over WireGuard.

## Features

- 💬 Multi-provider LLM chat (OpenAI / Google / Anthropic compatible APIs), multimodal
  input, assistants, message branching, translation
- 🤖 On-device agent runtime: full Linux rootfs under proot running real agent CLIs
- 👁️ Device control: accessibility service exposing screen-read + tap/swipe/type to
  local agents
- 🖥️ Built-in terminal with real PTYs into the on-device runtime
- 🕸️ Optional mesh membership: WireGuard VPN, shared filesystem, memory capture —
  bring your own RivetOS node(s); everything is configured in-app, nothing baked in
- 📝 Markdown rendering (code highlighting, LaTeX, tables, Mermaid), MCP support,
  search providers, AI translation
- 🎨 Material You, dark mode, emerald-on-dark Rivet theme

## Building

Standard Gradle Android build (Android Studio or CLI). See `AGENT.md` for the full
development guide, architecture notes, and deploy workflow. Release signing uses your
own keystore; no credentials or environment specifics ship in this tree.

This app lives in the RivetOS monorepo but builds with **Gradle, not npm/nx** — it's an
nx project for graph membership and DDD boundaries only, and its real targets are named
so CI's SDK-less sweeps skip them (`build`/`test`/`lint` aren't defined). On a machine
with an Android SDK, from the monorepo root:

```
nx apk @rivetos/rivet-android          # assemblePhilDebug
nx check @rivetos/rivet-android        # unit tests
nx verify @rivetos/rivet-android       # android lint
nx apk-release @rivetos/rivet-android  # signed release build
```

or run `./gradlew` directly in this directory.

## License

AGPL-3.0. Derived from [RikkaHub](https://github.com/rikkahub/rikkahub) — thanks to
the upstream project for the excellent foundation. See `LICENSE`.
