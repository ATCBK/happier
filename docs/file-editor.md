# File editor

The File page edits the file on its selected Machine. The client owns the open
buffer and device-local draft; the Machine owns the file bytes. A Save crosses
that boundary with the hash of the bytes the person last saw.

This page describes the unreleased 0.3 editor contract. The state hook, conflict
projection and compact draft reader are present in development source with
composed owner-level test coverage. The loaded-runtime journey through guarded
writes, Markdown, Actions and rendered surfaces still needs integrated validation
before treating the complete workflow as available. This is not a released-client
or completed live-validation claim.

## Owners

- `apps/ui/sources/components/workspaces/files/details/workspaceFileDetails/useWorkspaceFileEditorState.ts`
  owns the edit session, base, draft, save and conflict decisions. The File page
  consumes its model and owns page chrome; it does not infer another status.
  `workspaceFileEditorConflict.ts` supplies its pure conflict projection and
  `workspaceFileEditorDraft.ts` owns the Account-qualified draft reader.
- `apps/ui/sources/components/ui/code/editor/CodeEditor.tsx` selects the platform
  surface. `codeEditorTypes.ts` owns the single `CodeEditorHandle` contract for
  commands, reveal, history, selections and layered decorations.
- `CodeEditorWithFind.tsx` in the same folder owns editor Find composition.
  `apps/ui/sources/components/ui/markdown/editor/useMarkdownEditMode.ts` owns
  Raw/Rich mode and flush-before-switch; `MarkdownCodeEditorField` consumes it.
- `apps/ui/sources/utils/navigation/runGuardedNavigation.ts` owns departure
  decisions. File tabs register their dirty guard there and use the same guard
  for close, including keyboard and middle-click close.
- `apps/ui/sources/sync/ops/workspaceFileSystem/fileReadWrite.ts` owns client
  write routing. The existing filesystem Action and upload finalizer reach the
  Machine's one guarded replacement owner, described below.

Review hunks come from the Protocol hunk engine; Keep/Discard and their content
keys belong to the review owner. Diagnostics and blame use named decoration
layers on the same handle. They do not create another editor or buffer store.

### Markdown mode availability

Reading Markdown uses the File header's Preview / Source choices. Editing uses
the shared field's Raw / Rich menu at the upper right of the editor. That menu
is offered only for the `markdown` language while the existing
`files.markdownRichEditor` preference is enabled. This retained experimental
preference is off by default and requires the Features page's experiments
switch; the File page does not override that policy. Document eligibility may
disable Rich with a reason while Raw remains available. Raw Find is owned by
`CodeEditorWithFind`, not a separate Markdown search implementation.

## Syntax highlighting

In 0.3 development, `filesDiffSyntaxHighlightingMode` defaults to `advanced`
at the Protocol Account catalog in
`packages/protocol/src/account/settings/accountSettings.ts`. The UI Settings
parser and Source Control settings screen consume that owner. Missing values
use the default; explicit `off`, `simple` and `advanced` values retain their
meaning, including 0.2-written preferences. No stored Account value is migrated.

`resolveCodeLinesSyntaxHighlightingMode` keeps advanced tokenization web-only
and falls back to simple on native or when the advanced feature is disabled.
The existing `filesDiffTokenizationMaxBytes`, `filesDiffTokenizationMaxLines`
and `filesDiffTokenizationMaxLineLength` preferences still govern highlighting;
`evaluateCodeHighlightingBudget` protects code blocks and
`resolveEffectiveSyntaxHighlighting` protects code-line views. Over-budget
content remains readable without adding another size limit.

## State and rendering locality

The edit session holds the base text/hash, its BOM fact, the draft, a
single-flight save, a refusal and one recoverable set-aside draft. The live text
stays in refs and a subscribable text store; page-level state changes when dirty
or lifecycle state changes, rather than on every keystroke. `liveValue` exposes
`get()` and `subscribe()` to Markdown eligibility and language intelligence.
The existing intelligence controller uses that draft only while Edit is selected;
View and Changes project the saved text shown by their reading body into the same
controller and `@` outline. Switching this coordinate basis resynchronizes its
versioned document without replacing the draft. Markers for unacknowledged text
are removed before synchronization waits, and late older-version diagnostics
cannot restore them. The unsaved flag still follows
the retained editor, so disk-based agent Actions continue to refuse dirty files.

`editorStatus` is derived as `clean`, `dirty`, `saving` or `conflict`. A conflict
requires a changed disk hash and draft text different from disk. When disk equals
the draft, the base is adopted; when disk returns to the base hash, the conflict
clears. A clean buffer reseeds from a refreshed disk version. A dirty buffer is
never silently overwritten by refresh.

Save keeps the edit session open. A successful write advances the base to the
text actually sent and its returned hash; text typed during the write remains
dirty. The loader receives that version before refresh so an older read cannot
be presented as an external write. Saved is a short presentation state, not
another persistence state. Autosave remains opt-in and is suspended by a
conflict or refusal; reconnection alone does not save.

Acknowledged Save, Discard/Restore and Replace/Undo results notify the same
mounted saved-byte loader through `workspaceFileAcknowledgements.ts`. The
notification is qualified by Home, Account, Machine and canonical file path;
it carries the writer's returned hash, not inferred text. The loader invalidates
older reads and reuse, records the own-write hash before refreshing, and defers
hidden-page reads until the page is active. A failed read retains the last
useful content with stale freshness; a dirty editor remains untouched. This
notification holds no file bytes, history or watcher, and adds no per-feature
refresh policy. A known-text Save still publishes its exact acknowledged text
immediately through that loader.

The focused details group's active editor owns the save keyboard command.
Retained editors in other groups must not handle that command. The mounted
editor Action owner uses the same hook operations, without opening a new editor.

## Drafts and departure

The canonical draft record is
`{ accountId, isEditingFile, editorOriginalHash, editorText }`. It contains no
copy of the original file. Readers qualify by Account, ignore unknown fields
and reject records without the original-hash field; writers emit only this shape.
Pane tab state persists through the existing device-local pane settings owner.
The original-text draft shape is an undeployed 0.3 intermediate, not a legacy
format requiring a second reader.

Dirtying a preview tab pins it. Switching to View or Changes leaves its draft
session open. Closing a dirty tab goes through the shared Save / Discard / Keep
editing decision; a failed Save keeps the tab and draft. The unsaved-file-path
projection reads persisted tab state, so other-group and unmounted tabs count.
The compact draft module has no second module cache; tab-move/remount continuity
must be verified against the existing pane-state persistence owner.

Project-manifest authoring has a separate edit-session lifecycle: Back unmounts
its editor, so `projectManifestEditorModel.ts` retains its dirty draft and known
base in memory, qualified by Account and checkout. It consumes the compact draft
reader only for its optional persisted input and never persists original bytes.
It does not cache or decide file-pane draft state.

A held complete text read, or a restored draft with its original hash, remains
editable while the Machine is unreachable. With neither, there is no offline
file content to edit. Saving still attempts the Machine write and keeps the
draft on failure. The existing checkout reachability owner supplies retry and
reconnection facts; the editor adds no second poller or retry policy. A device
storage failure must be visible while the in-memory buffer remains editable.
The pane persistence owner reports asynchronous device-write failures through
`persistenceFailed`; the editor projects that into its dirty-draft warning. Only
storage-adapter write errors are caught, not serialization errors. The existing
next successful pane write clears the warning; there is no new retry loop.

## Guarded writes and byte identity

The write corridor is `workspaceWriteFile` →
`daemon.filesystem.writeFile` → `writeFileForRpc` (inline bytes), or the existing
upload finalizer (larger bytes), → `commitGuardedFileReplace` →
`writeFileAtomically`. Executor-side Discard, Restore and Replace consume that
same guarded replacement owner directly. No consumer owns a parallel writer.

The expectation is omitted for an unconditional write, `null` for a file that
must be absent, or a SHA-256 hex hash for the existing raw bytes. Guard failures
are `hash_mismatch`, `expected_file_missing` and `expected_file_absent`. Client
write results classify conflicts, approval, reachability, unsupported operations
and other failures once; the editor branches on that typed classification.

The guarded replacement contract extends the existing atomic writer: stage a
sibling file, preserve permission bits, fsync, and recheck the destination hash
immediately before each rename attempt, including the existing Windows retries.
Existing symlink destinations update their resolved target. Upload staging may
cross devices before the sibling is committed; replacing the destination must
not fall back to an in-place copy. This is optimistic concurrency: the final
check and rename are separate operations, not a lock against every possible
foreign writer. Ownership preservation is not promised.

An untouched added-file Discard uses `source: {kind:'absent'}` at this same
expectation owner. It checks the raw-byte hash immediately before atomic unlink
and returns `hash:null` for guarded recreation by Undo. Deleting a symlink removes
its directory entry; writing bytes through a symlink updates its target.

An unguarded upload with `overwrite:false` retains the existing exclusive-create
operation, which cannot replace a pre-existing file. Guarded creation with
`expectedHash:null` uses the guarded replacement owner. Cross-device staging
failures retain a transfer session only while its original staged source still
exists; a failed final rename returns `file_replace_failed` and removes its
temporary sibling without copying over the destination.

Both client and Machine hash raw bytes before text decoding. Complete valid
UTF-8 text can seed a saveable buffer; binary, truncated, failed or lossy-decoded
content cannot. A UTF-8 BOM is remembered and restored on Save. LF and CRLF files
keep their ending style; mixed endings normalize to the dominant style with a
quiet note before Save. Shared byte fixtures protect the hash basis.

Encoding metadata belongs to the editor's base (`Base.encoding`), not a mutable
draft intent. The editor offers no encoding or BOM control: Save preserves the
base format, and draft Discard restores text only. A draft whose only difference
is BOM metadata is therefore not a reachable user state. The persisted draft
keeps its four fields; no encoding field or second metadata owner is needed.

The inline size threshold chooses the transfer path, not editing eligibility.
Larger guarded saves carry the same `expectedHash` through upload finalization.
The removed editor-size setting imposes no replacement cap. Existing read and
transfer bounds still apply, and a partial preview is not an editable document.
`filesEditorBridgeMaxChunkBytes` remains solely the native CodeMirror bridge's
transport chunk size.

## Conflict resolution and Undo

Compare uses the page body and the shared DiffViewer hunk contract, with disk on
the old side and the draft on the new side. Use mine writes against the hash of
the disk version shown; it does not bypass the guard. Use theirs adopts disk and
retains one set-aside draft in memory. Per-place choices merge into the draft;
after every place is decided, its base becomes the shown disk version and Save
uses that hash. Automatic resolution of places touched only on disk requires
the in-memory base; after reload, Compare asks at every place.

Unrelated read-only comparisons, such as project-manifest conflict inspection,
use `components/ui/code/diff/TextComparisonModal.tsx`. That presentation wrapper
receives two snapshots and caller-owned subtitle copy. It neither resolves a
file-editor conflict nor owns a draft; the File page's comparison stays inline.

Use mine Undo writes the displaced version back guarded by the just-written
hash. Use theirs Undo restores the set-aside draft and derives the conflict
again. `PresentationNotice.sticky` supplies the shared dismissible Undo notice:
it has no timed window and retires on the next relevant edit/save/Compare/review
action, explicit dismissal or replacement. It is not a second draft history.

## Actions and plugin boundary

`daemon.filesystem.writeFile` retains the danger default for automated callers;
its present-user UI default is direct. Per-Action settings still govern explicit
approval choices. Approval-required saves use the existing approval continuation
and advance their base only after the write succeeds.

`file.editor.save` and `file.editor.resolve` address an already mounted editor
in its qualified scope, optionally by tab. Save reports saved, clean, conflict
or unavailable; Resolve reports resolved or unavailable. Automated calls use
ordinary approval admission. These Actions do not create a buffer, load a file
or choose a different Machine when the owner is absent. See [Actions](actions.md).

No editor contribution family is added. Installed plugins retain the existing
openable-content viewers and read-only diff surface; an open editing draft keeps
the host editor in control. Plugin Actions consume the existing host Action
boundary. See [plugin platform](plugin-platform.md).
