# Repository Guidelines

## Project Structure & Module Organization

This repository is currently documentation-first. Treat `docs_implement/implementation_plan.md` as the source of truth until code is scaffolded.

The planned layout is an OpenClaw plugin: `src/` for TypeScript runtime code, `src/clients/` for integrations, `src/tools/` for handlers, `contracts/` for the Sui Move package, `skills/baby_claw/` for skill instructions, `scripts/` for build helpers, `tests/` for coverage, and `examples/` for sample configs.

## Build, Test, and Development Commands

Use these commands as the planned files land:

- `npm install` installs Node dependencies.
- `npm run build` compiles the TypeScript plugin.
- `npm run test` runs TypeScript tests.
- `npm run build:contract-artifact` generates the runtime Move artifact.
- `cd contracts && sui move build` builds the Move contract.
- `cd contracts && sui move test` runs Move tests.
- `cd contracts && sui move test --coverage` checks contract coverage.

For plugin validation, use `openclaw plugins inspect baby_claw --runtime --json` after local installation and gateway restart.

## Coding Style & Naming Conventions

Use TypeScript for plugin code and Move for contracts. Prefer small modules. Name tool files by action, such as `recordMilk.ts`, `sleepEnd.ts`, and `getLast.ts`.

Contract names should stay privacy-neutral: use `ledger`, `Profile`, `Record`, and `RecordKey`; avoid domain-specific names such as `BabyProfile`, `MilkRecord`, or `PoopRecord`.

Do not hardcode secrets; read private keys, API URLs, and state paths from config or environment variables.

## Testing Guidelines

Add focused tests with each step. TypeScript tests should cover tools, state, client adapters, and error cases. Move tests should cover profile minting, record creation, sequence increments, authorization, and empty payload/blob validation.

Run the relevant local test command before opening a PR. For contract changes, include `sui move test` and coverage output.

## Commit & Pull Request Guidelines

- Use the `$Commit Message` skill to create commit messages and make commits.
- Use the `$GitHub PR Creator` skill for pull requests.

## Security & Configuration Tips

Never expose `SUI_PRIVATE_KEY`, encryption keys, raw baby records, image data, or unencrypted notes in logs or chat responses. Store local state under `stateDir`, and keep on-chain data limited to IDs, hashes, buckets, and encrypted blob references.
