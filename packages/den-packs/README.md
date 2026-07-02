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

`packs/default` is `default-pack@1`: the prototype den art (s440 character
family, Phil's room arrangement) migrated into the manifest format.
