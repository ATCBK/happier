# Claude Code

@AGENTS.md

## TypeScript commands

Follow the canonical TypeScript compiler-ownership rules in `AGENTS.md`: tsrs handles typechecks and their internal declarations on Linux x64/arm64 and macOS arm64, including routine CI. Microsoft 7.1.0-beta owns builds/shipped declarations, release validation, editors and other platforms. Use `HAPPIER_TYPESCRIPT_COMPILER=microsoft|tsrs` for typechecks (`auto` restores selection); builds stay Microsoft and failures never fall back. Use repository/package typecheck and build scripts; `pnpm run tsc ...` from the repository root and TypeScript-owning workspaces delegates to the same runner as `node scripts/workspaces/runTypeScriptCli.mjs ...`. Direct compilation routes through `hstack-exec` AUTO on POSIX; executor/admitted descendants keep their selected machine. Standalone `--version`/`--help` queries and Windows stay local. A leading `--local` delegates to executor policy, including the controller's explicit `--allow-local-compilation` requirement; do not use this escape for whole-package checks on nl2. Do not run bare `tsc`, `npx tsc`, `node_modules/.bin/tsc`, or `typescript/bin/tsc`; the `typescript` package remains TypeScript 5.9 only for programmatic API compatibility.
