# RivetHub Agent Runtime — Architecture Plan

_Status: PROPOSED. Written 2026-06-09. Supersedes the cross-app token bridge once delivered._

## The goal

Today RivetHub (the privileged app: Accessibility "eyes + hands" + loopback control
server) and the on-device agent (Claude Code / Grok CLI, currently in **Termux**) are
**two separate Android apps with two separate uids**. That split is the entire source of
the friction we just hit: the agent can't read RivetHub's control token, because the
token lives in RivetHub's private storage and Termux's uid can't see it (nor can it read
RivetHub's logcat).

The north star: **one app, one uid.** The agent runs *inside* RivetHub's process space,
as RivetHub's uid, sharing its permissions, its files, and its in-process access to the
Accessibility service. When that's true:

- The token + loopback HTTP server become **internal-only** — the in-app agent calls the
  Accessibility service directly in Kotlin (no HTTP, no token). The loopback server stays
  only for *external* drivers (desktop via `adb forward`, debugging).
- "Share the same permissions and access" (Phil's framing) is satisfied by construction.

## Why not just share a uid between the two apps

`android:sharedUserId` was the old mechanism. It's a dead end:

- **Deprecated** since API 29; Google is actively removing it.
- **Cannot be retrofitted** onto an already-installed app — it's fixed at first install.
  Changing it is an uninstall/reinstall and data loss.
- Requires **both apps signed with the same key** and **both declaring the same id from
  day one**. Termux upstream doesn't, and we don't control Termux's install.

So uid-sharing across two installed apps is off the table. The only way to truly share a
uid is to **be the same app** → embed the userland in RivetHub.

## The approach: embed a Termux-style Linux userland in RivetHub

The on-device agents are real CLI programs (Claude Code, Grok — node/python based). They
need a POSIX userland. Termux *is* exactly "an Android app that hosts a Linux userland
under its own uid." So the plan is to make RivetHub host that userland itself.

Termux is FOSS (GPLv3). RivetHub is AGPLv3 (inherited from RikkaHub). AGPL is compatible
with GPLv3, and this is Phil's personal device — license weight is nil. The reusable
pieces (`terminal-emulator`, `terminal-view`, the bootstrap rootfs) are designed to be
vendored.

### The landmine: the exec wall (W^X at high targetSdk)

Android 10+ enforces **W^X**: an app at a high `targetSdk` **cannot `exec()` binaries
from its writable data dir**. Termux only runs node/python/etc. because it deliberately
pins **`targetSdk 28`** to keep exec-from-`$HOME` working. **RivetHub is `targetSdk 37`
(Android 16)** — so a naive "extract a bootstrap to files dir and run it" is blocked.

Three known ways around it, in rough order of effort:

1. **`jniLibs` trick (Termux's own approach for high targetSdk).** Ship executables as
   `lib*.so` inside the APK's `jniLibs/<abi>/`. The app's `nativeLibraryDir` is the one
   place that stays executable regardless of targetSdk. Termux-app's newer builds + the
   `termux-exec` shim use this. Most "correct" but the most packaging work (every binary
   becomes a `.so`, plus a `LD_PRELOAD`/`termux-exec` shim to rewrite shebangs & paths).
2. **`proot` (userspace).** Run the whole userland under `proot` (a single statically
   linked binary shipped via the jniLibs trick). Heavier runtime cost, but the userland
   itself needs no per-binary repackaging. This is how Termux-style distros run on
   locked-down environments.
3. **Lower RivetHub's `targetSdk` to 28.** Simplest exec-wise, but we lose Android
   13–16 behaviors/APIs and some platform features. Since RivetHub is **sideloaded**,
   Play Store targetSdk minimums don't apply — so this is *viable* and the cheapest path
   to a working prototype, at the cost of running an old target on a new OS.

**Recommended sequencing:** prototype on path (3) to prove the in-app agent loop end to
end with minimal yak-shaving, then migrate to path (1) or (2) for the real build so we
keep targetSdk current. Decide (1) vs (2) after measuring proot overhead with the actual
agent CLIs.

## Components / work breakdown

1. **Userland bootstrap.** Vendor a per-ABI bootstrap (aarch64 first) — busybox/coreutils
   + a package manager + the runtimes the agents need (node, python, git). Extract to
   RivetHub's private dir on first run. Decide bootstrap source: reuse Termux's published
   bootstrap zips, or build a trimmed one with only what the agents need.
2. **Exec mechanism.** Implement the chosen exec path (jniLibs+termux-exec / proot /
   low-targetSdk). This is the highest-risk item — spike it *first*, in isolation, before
   building anything on top.
3. **Terminal / process host.** Vendor `terminal-emulator` + `terminal-view`, or run the
   agent headless (no visible terminal) and surface its I/O through RivetHub's own UI.
   For an agent we mostly want headless + a log/console pane, not a full interactive term.
4. **Agent ↔ device control, in-process.** Replace the agent's HTTP calls to
   `127.0.0.1:9876` with **direct Kotlin calls** into `RivetAccessibilityService`
   (`dumpUiTree`, `tap`, `swipe`, `typeText`, `performGlobal`, …). Expose these to the
   agent process via a thin local IPC (Unix socket in the app's own dir, or a JNI/stdin
   protocol) — now trivially secure because it never leaves the uid.
5. **Lifecycle / reliability.** Foreground service + wakelock so the agent survives doze;
   `Termux:Boot`-equivalent auto-start; crash/restart supervision.
6. **Mesh membership.** WireGuard into the mesh (→ GERTY inference + datahub) so the
   in-app agent reaches the same model/memory backends as the rest of Rivet. (Was already
   on the roadmap; folds in here.)
7. **Decommission the cross-app path.** Once the in-app agent works, the loopback token
   bridge to Termux is legacy — keep the loopback server for desktop/adb only.

## Open questions / decisions for Phil

- **Keep Termux too, or fully absorb it?** Even after embedding, you may want standalone
  Termux for ad-hoc shell work. Embedding doesn't force removing Termux — it just gives
  RivetHub its *own* userland for the agent.
- **Exec path:** prototype on low-targetSdk (fast) vs. go straight to jniLibs/proot
  (correct). Recommend: prototype low-target, ship correct.
- **Headless agent vs. visible terminal** inside RivetHub. Recommend headless + console
  pane.
- **Which agent runs in-app** — Claude Code, Grok, or both, and how model/token config is
  provisioned at first run.

## Interim state (delivered today)

Until the embed lands, the **token bridge** is live: `RivetAccessibilityService` writes
`{"port":9876,"token":"…"}` to `/sdcard/rivet/control.json` on connect (requires
All-Files-Access granted to RivetHub). The Termux-side agent reads that file to obtain the
token and drives the loopback control server. This is intentionally throwaway — it gets us
a verified eyes+hands loop now, and is removed when the agent moves in-process.
