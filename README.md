# swamp-extensions

Custom extensions for [Swamp](https://github.com/swamp-club/swamp).

## Extensions

| Extension | Description |
| --- | --- |
| [`@josh/sprites`](sprites/) | Fly.io Sprites: command execution, files, services, checkpoints, task holds, and network access. |

See each extension's README for installation, usage, and requirements.

## Development

Each extension has its own Deno tasks and Swamp manifest. Work from the extension directory; for Sprites:

```sh
cd sprites
```

On a fresh checkout, initialize the package's local Swamp repository once:

```sh
swamp repo init --tool none
```

Use Deno on PATH, or run `swamp doctor extensions --json` to find Swamp's bundled Deno and use that path below.

```sh
deno task check
deno task lint
deno task fmt:check
deno task test
deno task test:transport
swamp extension fmt manifest.yaml --check --json
swamp extension quality manifest.yaml --json
```

Run `deno task fmt` to format the source. Transport tests require `openssl` and start local TLS/WebSocket servers. Neither test task calls the Sprites API.

## License

swamp-extensions is licensed under the MIT license. See the [`LICENSE`](LICENSE) file for more information.
