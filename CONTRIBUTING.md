# Contributing

Thanks for helping improve `godot-playtest`.

## Prerequisites

- Git
- Node.js 22 recommended (Node.js 20 is the minimum supported runtime)
- npm
- Godot 4.6.3 for integration and addon tests
- Python 3 for the conformance and runner harnesses

## Set up the MCP server

```sh
cd mcp-server
npm ci
npm run build
npm test
```

The unit suite uses a fake Bridge and does not require Godot.

## Run integration tests

Set `GODOT_BIN` to the Godot executable, then run:

```sh
cd mcp-server
npm run test:integration
```

The repository's GitHub Actions workflows also run the Bridge conformance,
export-guard, frozen-test runner, and TPS demo dogfooding suites. The exact
commands are recorded in [.github/workflows/](.github/workflows/).

## Make a change

1. Create a focused branch from `main`.
2. Keep protocol behavior in the Bridge; the MCP server should remain a thin
   translation layer.
3. Add or update tests for behavior changes.
4. Update public documentation when a command, tool, or compatibility rule
   changes.
5. Run the smallest relevant suite locally before opening a pull request.

Use English for code, comments, commit messages, documentation, and user-facing
text. Keep generated caches, local Godot imports, dependencies, and build output
out of commits.

## Pull requests

Explain the user-visible change, the reason for it, and how it was verified.
Keep pull requests scoped to one coherent change. All required checks must pass
before merge.

By contributing, you agree that your contribution is licensed under the
repository's [MIT License](LICENSE).
