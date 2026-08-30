# Releases

How RivetOS is versioned and what “stable” means for RivetHub.

Stable is an annotated git tag `vX.Y.Z` cut from green `main`. The RivetHub distro repo pins those tags. There is no LTS track and no backport promise: a fix ships in the next tag.

---

## Artifacts

Each stable release produces:

| Artifact | What it is |
|---|---|
| Git tag `vX.Y.Z` | Annotated tag on the green `main` commit. Checkout and run from source (`npx tsx` / the systemd unit) — the proven path. |
| `ghcr.io/philbert440/rivetos:X.Y.Z` | Container image from that tag. `docker/metadata-action` `type=semver,pattern={{version}}` strips the leading `v`. |
| `ghcr.io/philbert440/rivetos:latest` | Same image. `latest` is written only when a `v*` tag is pushed, not on every `main` merge. |

`main` is the nightly channel. Every push to `main` (after CI) publishes `ghcr.io/philbert440/rivetos:main`. Nightly is unsupported for production.

---

## Install and update (git, default)

`rivetos update` is git mode unless you pass `--npm` or `--channel`. Git mode needs a source checkout.

```bash
# Pin to a stable tag (fetch + git checkout)
rivetos update --version vX.Y.Z

# Track origin/main (nightly). No --version → fetch, checkout main, reset --hard origin/main.
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
