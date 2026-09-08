# Releases

How RivetOS is versioned and what “stable” means for RivetHub.

There is no LTS track and no backport promise: a fix ships in the next tag. This document supersedes leftover LTS / `lts/X.Y` language in README.md and ARCHITECTURE.md pending #589.

## Channels

| Channel | Where | What it is for |
|---|---|---|
| **Stable** | Production server: [rivethub.io](https://rivethub.io/) and [get.rivethub.io](https://get.rivethub.io/) (`local.sh`, `pins/stable.json`, `releases/latest.json`, AppImage / exe / apk) | First-install. |

The laptop one-liner:

```bash
curl -fsSL https://get.rivethub.io/local.sh | bash
```
| **Dev / nightly** | Mesh share `/rivet-shared/builds/rivethub/` (`latest.json` + binaries) | Already-installed desktop and Android (Settings → Updates over mTLS). Unsupported for production. |
| **Source pin** | Annotated git tag `vX.Y.Z` on green `main` | What `local.sh` clones (`pins/stable.json` `local_ref`). **Not** the app update feed. GitHub Releases are not the supported install path. |

Container images (`ghcr.io/philbert440/rivetos:…`) still follow the git tag. `main` also publishes `ghcr.io/philbert440/rivetos:main` after CI.

---

## Artifacts

Each stable source pin produces:

| Artifact | What it is |
|---|---|
| Git tag `vX.Y.Z` | Annotated tag on the green `main` commit. Source pin for `local.sh` / `rivetos update --version`. |
| `ghcr.io/philbert440/rivetos:X.Y.Z` | Container image from that tag. `docker/metadata-action` `type=semver,pattern={{version}}` strips the leading `v`. Pin this. |
| `ghcr.io/philbert440/rivetos:X.Y` | Same image, `type=semver,pattern={{major}}.{{minor}}`. **Floating** — moves on each patch of that minor (not a pin; there is no backport track). |
| `ghcr.io/philbert440/rivetos:<short-sha>` | Same image, `type=sha,format=short`. Emitted on every containers push (main and tags). |
| `ghcr.io/philbert440/rivetos:latest` | Same image. `latest` is written only when a stable `vX.Y.Z` tag is pushed (not pre-release `v*` tags, not every `main` merge). |

---

## Install and update (git, default)

`rivetos update` is git mode unless you pass `--npm` or `--channel`. Git mode needs a source checkout.

```bash
# Pin to a stable tag (fetch + git checkout)
rivetos update --version vX.Y.Z

# Track origin/main (nightly). No --version → fetch, checkout main, reset --hard origin/main.
# git reset --hard discards uncommitted local changes in the checkout.
rivetos update
```

`--version` is git-mode only. It does not select an npm dist-tag.

---

## npm (experimental)

`--npm` and `--channel` install `@rivetos/cli` from the npm registry instead of git. This path is experimental.

```bash
rivetos update --npm                 # @rivetos/cli@beta  (--channel defaults to beta)
rivetos update --channel latest      # implies --npm; npm dist-tag (or a version string)
```

Do not treat npm `latest` / `beta` as the production pin. Prefer a git tag or a GHCR semver tag.

---

## Versioning

SemVer. A `vX.Y.Z` tag is one release; workspace package versions are aligned for that tag.

Pre-release versions (for example `0.4.0-beta.6` on individual packages) are not a stable pin.

---

## What we do not promise

No LTS, no `lts/X.Y` branches, no backport window. A working tag stays that commit; it does not keep receiving fixes. Upgrade to the next `vX.Y.Z` for patches.
