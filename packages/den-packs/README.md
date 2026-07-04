# @rivetos/den-packs

SpritePack spec, validator, and the reference `default` pack for
**rivet-den**. A pack is a directory of PNGs plus a `pack.json` manifest
carrying everything the renderer needs — art grid, chroma key, pose sets,
furniture geometry, layout, stations. See [PACK.md](./PACK.md).

```sh
den-pack validate packs/default
```

```ts
import { validatePack } from '@rivetos/den-packs'
const { ok, errors, manifest } = validatePack('path/to/pack')
```

`packs/default` is `default-pack@2`: the high-fi Grok Imagine art set —
see [ART-PIPELINE.md](ART-PIPELINE.md) for how it was authored.
