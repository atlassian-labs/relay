# Contributing to Relay

Thank you for considering a contribution to Relay! Pull requests, issues and comments are welcome. For pull requests, please:

- Add tests for new features and bug fixes
- Follow the existing style
- Separate unrelated changes into multiple pull requests

See the existing issues for things to start contributing.

For bigger changes, please make sure you start a discussion first by creating an issue and explaining the intended change.

Atlassian requires contributors to sign a Contributor License Agreement, known as a CLA. This serves as a record stating that the contributor is entitled to contribute the code/documentation/translation to the project and is willing to have it used in distributions and derivative works (or is willing to transfer ownership).

Prior to accepting your contributions we ask that you please follow the appropriate link below to digitally sign the CLA. The Corporate CLA is for those who are contributing as a member of an organization and the individual CLA is for those contributing as an individual.

- [CLA for corporate contributors](https://opensource.atlassian.com/corporate)
- [CLA for individuals](https://opensource.atlassian.com/individual)

## Development Setup

Relay requires [Bun](https://bun.sh) (version pinned in `.bun-version`).

```bash
# Install Bun
curl -fsSL https://bun.sh/install | bash

# Clone the repository
git clone https://github.com/atlassian-labs/relay.git
cd relay

# Install dependencies
bun install

# Run from source
bun run dev --agent codex

# Build
bun run build
```

## Checks and Tests

Run the full check suite before submitting a PR:

```bash
bun run check
```

Individual steps:

```bash
bun run typecheck       # TypeScript type checking
bun run lint            # Oxlint
bun run lint:effect-shape  # Effect shape constraints
bun run format:check    # Formatting check
bun test                # Unit tests
bun run build           # Production build
```

## Code Style

- No `any` types unless absolutely necessary.
- No inline imports -- use standard top-level `import` statements.
- Prefer Bun APIs and existing project helpers over Node/package-manager alternatives.

## Commit Messages

Follow conventional commit prefixes: `feat:`, `fix:`, `docs:`, `build:`, `test:`, `refactor:`, `chore:`.

## Issue Triage

Maintainers review new GitHub issues and PRs on a regular cadence. For urgent issues, tag them with the `urgent` label. We aim to respond to new issues within one week.

## License

By contributing to Relay, you agree that your contributions will be licensed under the [Apache License 2.0](LICENSE).
