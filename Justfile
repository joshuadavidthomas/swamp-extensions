set dotenv-load
set unstable

# List all available commands
[private]
default:
    @just --list

lint *ARGS:
    @just --fmt --check
    uvx prek run --all-files --show-diff-on-failure --color always {{ ARGS }}
