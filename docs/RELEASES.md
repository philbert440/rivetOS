# RivetOS Release Strategy

**Last updated:** April 2026

## Versioning

RivetOS follows [Semantic Versioning](https://semver.org/):

- **MAJOR** — breaking changes to core interfaces (Provider, Channel, Tool, Memory)
- **MINOR** — new plugins, features, non-breaking additions
- **PATCH** — bug fixes, security patches

## Branches

| Branch | Purpose |
|--------|---------|
| `main` | Current development. Gets new features. |
| `lts/X.Y` | Long-term support. Bug fixes and security patches only. |

## LTS Policy

After **v1.0.0**, LTS branches are created for each minor release:

- `lts/1.0` — created when v1.1.0 ships
- `lts/1.1` — created when v1.2.0 ships
- Each LTS branch receives **security and bug fixes only** for **12 months**
- No new features, no breaking changes, no dependency upgrades (except security)

### What LTS means

Pin to an LTS version and forget about it. It won't break. If you need new features, upgrade to `main`. If you need stability, stay on LTS.

This is the thing nobody else in this space offers. Every other project ships weekly and breaks monthly.

## Release Process

1. Features land on `main` via PRs
2. When ready for release, tag `vX.Y.Z` on main
3. Create GitHub Release with changelog
4. If this is a new minor version and the previous minor is in production, create `lts/X.(Y-1)` branch

## Pre-1.0

Before v1.0.0, the API is unstable. Breaking changes may happen in minor versions. Pin to exact versions if you need stability during this period.

## Current Status

**v0.0.8** — Pre-release. M0-M3 complete. API is experimental. Apache 2.0 licensed.

## License

[Apache License 2.0](LICENSE)
