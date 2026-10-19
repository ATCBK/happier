# Zod Classic to Mini codemod

Use the repository's routed executor for scans and fixture tests:

```sh
./apps/stack/bin/hstack-exec -- node scripts/codemods/zod-mini/cli.mjs scan
./apps/stack/bin/hstack-exec -- node --input-type=module -e 'await import("./scripts/codemods/zod-mini/index.test.mjs");'
```

For an off-tree validation copy, pass `--root <absolute scratch directory>` before the command and pass paths relative to that root. The same source-proven import resolution and whole-file refusal rules then use the scratch copy's current files and package manifests. For example, `node scripts/codemods/zod-mini/cli.mjs --root /absolute/scratch apply --write packages/protocol/src` changes only that bounded scratch subtree. The tool rejects paths outside the selected root, including symlinks that resolve outside it. Run package compilation and owner tests in the scratch copy before applying the same bounded batch to the shared checkout.

The default scan covers authored source under `apps`, `packages`, and `scripts`, including authored `build`, `public`, and `distribution` directories. It excludes declaration files and paths under `node_modules`, `coverage`, `generated`, `vendor`, `.expo`, `.next`, `.happier-plugin`, and directories named `dist` or beginning with `dist.` or `dist-`, plus `*.generated.*` files. Generated compiler inputs are tracked through their source generator rather than rewritten directly. The scan emits JSON with each `zod`, `zod/v4`, or `zod/mini` import, package API counts, and unresolved file/line/method sites. `apply <path ...>` previews the same report. `apply --write <bounded file or subdirectory ...>` changes only those paths, and only when every identified operation in that file is safe. It rereads bytes before each write to avoid overwriting concurrent edits. Re-run after fixing an unresolved site; the transformation is idempotent.
The UI password-KDF worker at `apps/ui/public/happier-password-kdf-worker.js` is also excluded by exact path: `apps/ui/tools/password/buildPasswordKdfWorker.mjs` generates that minified bundle from authored source. Other authored public files remain in scope.

`bridge <path ...>` previews a narrower intermediate migration for calls to imported functions whose source proves a Zod-schema return, such as `asProtocolZod`. `bridge --write <bounded path ...>` adds a Mini namespace and converts only chains rooted in those functions, while leaving unrelated Classic builders and imports unchanged. It still refuses a whole file when a proven factory chain is unsupported. The bridge is temporary integration tooling; the final migration uses `apply` to eliminate Classic imports.

The AST parser comes from the root `ts-morph` development dependency. This is a source migration tool, not shipped runtime code. It preserves untouched source ranges; it does not format entire files. A named Zod import without a proven Mini/core mapping, an opaque schema-like import, or an unsupported fluent operation leaves the entire file unchanged. Schema lineage follows local declarations, relative imports/barrels, `@/` aliases from the owning tsconfig, and first-party package exports only when their `happier-source` branches agree. External schemas, including SDK-owned Classic schemas, are not assumed to be Mini.
