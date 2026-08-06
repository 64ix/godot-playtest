# Security policy

## Supported versions

`godot-playtest` is pre-1.0. Security fixes are applied to the latest release
and the `main` branch; older releases are not maintained separately.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability.

Use GitHub's private vulnerability reporting flow from the repository's
**Security** tab and include:

- the affected addon or MCP server version;
- the Godot version and operating system;
- reproduction steps or a minimal project;
- the expected impact;
- any suggested mitigation, if known.

If private vulnerability reporting is temporarily unavailable, contact the
maintainer privately through their GitHub profile and only share technical
details after a private channel has been established.

The maintainer will acknowledge a complete report, assess its impact, and
coordinate a fix and disclosure timeline with the reporter.

## Security model

The Bridge is intended for controlled playtest environments. It binds to
loopback and remains dormant unless explicitly activated. Do not expose its
port to an untrusted network, and do not enable the playtest feature in a
production export. The addon export guard and activation rules are documented
in [addons/playtest/README.md](addons/playtest/README.md).
