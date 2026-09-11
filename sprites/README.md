# @josh/sprites

[Swamp](https://github.com/swamp-club/swamp) models for
[Sprites](https://sprites.dev): execution, files, services, checkpoints,
policies, networking, and connectors.

| Model type                   | Scope                                                            |
| ---------------------------- | ---------------------------------------------------------------- |
| `@josh/sprites/organization` | The token's Fly organization and its Sprite and connector lists. |
| `@josh/sprites/sprite`       | One named Sprite: execution, files, policies, and networking.    |
| `@josh/sprites/service`      | One Sprite service: definition, lifecycle, logs, and signal.     |
| `@josh/sprites/checkpoint`   | One named slot holding a Sprite checkpoint.                      |
| `@josh/sprites/task`         | One task hold on a Sprite.                                       |
| `@josh/sprites/connector`    | One organization connection: policy and OAuth.                   |

## Setup

This package is unpublished. From another Swamp repository, load its source:

```sh
swamp extension source add /path/to/sprite-swamp/sprites
```

When developing in this checkout, run Swamp from `sprites/`; it discovers the
models there automatically.

Store your organization token in an existing Swamp vault. These examples use a
vault named `sprites-secrets`:

```sh
swamp vault put sprites-secrets API_TOKEN
swamp model create @josh/sprites/sprite build-sprite \
  --global-arg name=build-worker \
  --global-arg 'token=${{ vault.get("sprites-secrets", "API_TOKEN") }}'
swamp model method run build-sprite create
swamp model create @josh/sprites/service build-web \
  --global-arg sprite=build-worker --global-arg service_name=web \
  --global-arg 'token=${{ vault.get("sprites-secrets", "API_TOKEN") }}'
```

The token determines the organization. Use separate model instances and vault
keys for different organizations.

## Usage

The setup creates a remote Sprite; provider charges apply. Configure its service
and run code on it:

```sh
swamp model method run build-web put --input '{"service":{"cmd":"python3","args":["-m","http.server","8080"],"http_port":8080}}'
swamp model method run build-sprite exec --input '{"cmd":["python3","-c","print(6 * 7)"]}'
swamp data get build-sprite stdout
```

For an existing Sprite, run `lookup` instead of `create` to save its identity.
Mutations check that identity and reject a replacement with the same name.
Inspect the target before deleting it:

```sh
swamp model get build-sprite --json
swamp model method run build-sprite delete
```

Find methods, arguments, and output schemas through Swamp:

```sh
swamp model type describe @josh/sprites/sprite --json
swamp model type describe @josh/sprites/organization --json
swamp model type describe @josh/sprites/connector --json
```

File writes, exec stdin, and gateway bodies accept
`{"kind":"text","text":"hello\n"}` or `{"kind":"base64","base64":"AP8="}`. They
never read files from the Swamp host. Exec saves `execution` metadata and binary
`stdout`/`stderr` artifacts; `failOnNonZero: false` retains nonzero exits.

Reference stored results in model definitions with CEL, for example
`${{ data.latest("build-sprite", "state").attributes.name }}`.

## Operational limits

- Store credentials in vaults. Binary artifacts are unencrypted files and expire
  after seven days; restrict repository and server access. Multi-artifact writes
  are not transactional.
- Requests default to a 64 MiB response cap. Inventory uses a 30-second timeout;
  Sprite and connector operations default to five minutes. Set `timeoutMs` and
  `maxResponseBytes` in model global arguments when needed. After a failed
  mutation, inspect remote state before retrying.
- Sprite `upgrade` and `restart` record request acceptance. Check the resulting
  runtime separately. Service startup events also need an application readiness
  check.
- Service `signal`, Sprite `listTasks`, and task `create`, `get`, `refresh`, and
  `delete` use `/usr/bin/curl` against `/.sprite/api.sock` through authenticated
  exec. Child models save their Sprite identity; later calls reject a
  replacement. The organization token stays outside the Sprite.
- The TCP proxy runs over an authenticated exec relay and requires
  `/.sprite/bin/python3` inside the Sprite. Sized TTY commands also require it.
  The API's native proxy and the control-channel proxy were tested live and did
  not forward TCP closure to the client, which is why the exec relay is used.
- Stopping a service does not prevent its startup after reboot. Delete its
  definition for that. Explicitly stopped HTTP services need service `start` to
  resume; an incoming request alone does not start them.
- Checkpoints restore the writable overlay. They do not roll back `/tmp`. Task
  snapshots do not renew holds; refresh or release tasks explicitly.
- Connector policy updates replace the whole policy. Provisioning alone does not
  grant Sprite access; an empty policy denies access.

## Development

From `sprites/`, use Swamp's bundled Deno or a current Deno on PATH:

```sh
deno task check
deno task lint
deno task fmt
deno task fmt:check
deno task test
deno task test:transport
swamp doctor extensions --json
swamp extension fmt manifest.yaml --check --json
swamp extension quality manifest.yaml --json
```

Source files and their tests live in `extensions/models/`, with shared helpers
in `extensions/models/_lib/`.

Transport tests use `openssl` and local TLS/WebSocket servers. The default test
suites make no Sprites API calls.

## License

MIT. See [LICENSE](LICENSE).
