# swamp-extensions

A monorepo for custom [Swamp](https://github.com/swamp-club/swamp) extensions maintained by Josh Thomas. Each extension owns its source, tests, manifest, documentation, license, and release version. Packages can ship on their own schedule without a repository-wide version.

## Layout

```text
<extension>/
  .swamp.yaml
  manifest.yaml
  deno.json
  deno.lock
  README.md
  LICENSE
  extensions/
    models/
      *.ts
      *_test.ts
      _lib/
        *.ts
        *_test.ts
```

The first package is [`@josh/sprites`](sprites/README.md), which integrates Fly.io Sprites. Unrelated extensions belong in sibling package directories.

The root `.swamp.yaml` supports repository-wide discovery and agent tooling only. Do not put models, workflows, vaults, or release manifests at the root; run package lifecycle commands from the directory that owns the manifest.

## Development

Search the registry and installed model types before adding a package. Keep each external resource behind a typed Swamp model, put secrets in vaults, and use CEL expressions to pass stored output between models. A workflow should coordinate model methods rather than repeat their API logic.

Run extension checks against the package manifest:

```sh
cd sprites
swamp extension fmt manifest.yaml --check --json
swamp extension quality manifest.yaml --json
```

Use the bundled Deno path reported by `swamp doctor extensions --json` for direct type checks and tests.
