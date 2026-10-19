import { describe, expect, it } from 'vitest';
import { buildSessionInstructionsContextIntentV1 } from '../../actions/sessionStateFieldActions.js';
import { createSessionOwnerMetadataV1, parseSessionOwnerMetadataEnvelopeV1 } from '../metadata/sessionMetadataSchemasV1.js';
import { PromptStackEntryAuthoringV1Schema } from '../../prompts/library/promptStacksV1.js';
import { admitSessionContextIntentV1, readSessionMemoryEnabledV1, SessionContextIntentV1Schema, SessionPromptStackV1StoredSchema, writeSessionContextIntentV1ToMetadata } from './sessionContextV1.js';

describe('Session context field owner', () => {
  it('selects exactly one existing Doc as Plan, preserving that annotation through ordinary Context edits and metadata reads', () => {
    const metadata = { work: { memoryEnabled: false, sessionRolesV1: { overrides: {}, sessionRoles: {}, notes: 'Keep notes' }, promptStack: [
      { id: 'a', ref: { kind: 'doc', artifactId: 'doc-a' }, enabled: true, placement: 'system_append' },
      { id: 'b', ref: { kind: 'doc', artifactId: 'doc-b' }, enabled: true, placement: 'composer_insert' },
      { id: 'bundle', ref: { kind: 'bundle', artifactId: 'bundle' }, enabled: true, placement: 'system_append' },
    ] } };
    const select = (current: typeof metadata, entryId: string | null) => writeSessionContextIntentV1ToMetadata(current,
      SessionContextIntentV1Schema.parse({ kind: 'set_plan', entryId }));
    expect(select(metadata, null)).toBe(metadata);
    const selected = select(metadata, 'a');
    expect(selected.work.promptStack[0]).toHaveProperty('plan', true);
    expect(select(selected, 'a')).toBe(selected);
    const switched = select(selected, 'b');
    expect(switched.work.promptStack[0]).not.toHaveProperty('plan');
    expect(switched.work.promptStack[1]).toHaveProperty('plan', true);
    for (const [entryId, code] of [['absent', 'entry_not_found'], ['bundle', 'invalid_parameters']] as const) {
      expect(() => select(switched, entryId)).toThrow(code);
      expect(switched.work.promptStack[1]).toHaveProperty('plan', true);
    }
    let edited = writeSessionContextIntentV1ToMetadata(switched, { kind: 'reorder', entryId: 'b', siblingId: 'a', position: 'before' });
    edited = writeSessionContextIntentV1ToMetadata(edited, { kind: 'set_budget', entryId: 'b', maxChars: 3000 });
    edited = writeSessionContextIntentV1ToMetadata(edited, { kind: 'set_enabled', entryId: 'b', enabled: false });
    const created = createSessionOwnerMetadataV1({ metadata: edited });
    expect(created).toMatchObject({ ok: true });
    if (!created.ok) throw new Error('Session Plan owner metadata refused');
    const envelope = parseSessionOwnerMetadataEnvelopeV1(JSON.stringify({ t: 'plain', v: created.ownerMetadata }));
    expect(envelope).toMatchObject({ t: 'plain', v: { work: { memoryEnabled: false, sessionRolesV1: { notes: 'Keep notes' },
      promptStack: [{ id: 'b', plan: true, maxChars: 3000, enabled: false, placement: 'composer_insert' }, { id: 'a' }, { id: 'bundle' }],
    } } });
    expect(select(edited, null).work.promptStack.every(entry => !('plan' in entry))).toBe(true);
    expect(writeSessionContextIntentV1ToMetadata(edited, { kind: 'detach', entryId: 'b' }).work.promptStack
      .every(entry => !('plan' in entry))).toBe(true);
    expect(writeSessionContextIntentV1ToMetadata(edited, SessionContextIntentV1Schema.parse({ kind: 'set', entry: {
      id: 'b', ref: { kind: 'doc', artifactId: 'replacement' },
    } })).work.promptStack.every(entry => !('plan' in entry))).toBe(true);
    // Session selection cannot become an Account/Project authoring flag or an inline pointer.
    expect(PromptStackEntryAuthoringV1Schema.safeParse({ ...metadata.work.promptStack[0], plan: true }).success).toBe(false);
    expect(SessionContextIntentV1Schema.safeParse({ kind: 'set_plan', entryId: 'a', planEntryId: 'b' }).success).toBe(false);
    expect(SessionPromptStackV1StoredSchema.safeParse([
      { ...metadata.work.promptStack[0], plan: true }, { ...metadata.work.promptStack[1], plan: true },
    ]).success).toBe(false);
    expect(SessionPromptStackV1StoredSchema.safeParse([{ ...metadata.work.promptStack[2], plan: true }]).success).toBe(false);
  });
  it('does not rewrite Session metadata for already-applied list intents', () => {
    const metadata = { work: { memoryEnabled: false, promptStack: [
      { id: 'first', ref: { kind: 'doc' as const, artifactId: 'first' }, enabled: false, placement: 'system_append' as const, maxChars: 3000 },
      { id: 'second', ref: { kind: 'doc' as const, artifactId: 'second' }, enabled: true, placement: 'composer_insert' as const },
    ], sessionRolesV1: { notes: 'Retain Notes' } } };
    for (const intent of [
      { kind: 'set_enabled' as const, entryId: 'first', enabled: false },
      { kind: 'set_budget' as const, entryId: 'first', maxChars: 3000 },
      { kind: 'detach' as const, entryId: 'absent' },
      { kind: 'reorder' as const, entryId: 'first', siblingId: 'second', position: 'before' as const },
    ]) expect(writeSessionContextIntentV1ToMetadata(metadata, intent)).toBe(metadata);
  });
  it('requires a PromptDoc for reserved Session Instructions while admitting ordinary memory context', async () => {
    const intent = buildSessionInstructionsContextIntentV1({ kind: 'doc', artifactId: 'selected', serverId: 'home-2' });
    const readMemoryHeader = async () => ({ header: { v: 1, kind: 'memory_doc.v1', title: 'Memory' } });
    await expect(admitSessionContextIntentV1(intent, readMemoryHeader))
      .rejects.toMatchObject({ code: 'attachment_unavailable', reason: 'wrong_kind',
        ref: { kind: 'doc', artifactId: 'selected', serverId: 'home-2' } });
    const memoryIntent = SessionContextIntentV1Schema.parse({ kind: 'attach', entry: {
      id: 'session.memory', ref: { kind: 'doc', artifactId: 'selected', serverId: 'home-2' },
    } });
    await expect(admitSessionContextIntentV1(memoryIntent, readMemoryHeader)).resolves.toEqual(memoryIntent);
    await expect(admitSessionContextIntentV1(intent, async () => ({ header: {
      v: 1, kind: 'prompt_doc.v2', title: 'Instructions',
    } }))).resolves.toEqual(intent);
  });

  it('admits attachments from the current qualified header and rejects a dashboard before mutation', async () => {
    const intent = SessionContextIntentV1Schema.parse({ kind: 'attach', entry: {
      id: 'context', ref: { kind: 'bundle', artifactId: 'dashboard', serverId: 'home-2' },
    } });
    await expect(admitSessionContextIntentV1(intent, async ref => {
      expect(ref.serverId).toBe('home-2');
      return { header: { v: 1, kind: 'prompt_bundle.v2', title: 'Dashboard', bundleSchemaId: 'dashboard.v1' } };
    })).rejects.toMatchObject({ code: 'attachment_unavailable', reason: 'malformed' });
    await expect(admitSessionContextIntentV1(intent, async () => ({ header: {
      v: 1, kind: 'prompt_bundle.v2', title: 'Instructions', bundleSchemaId: 'skills.skill_md_v1',
    } }))).resolves.toEqual(intent);
    const docIntent = SessionContextIntentV1Schema.parse({ kind: 'attach', entry: {
      id: 'memory', ref: { kind: 'doc', artifactId: 'memory' },
    } });
    await expect(admitSessionContextIntentV1(docIntent, async () => ({ header: {
      v: 1, kind: 'memory_doc.v1', title: 'Memory',
    } }))).resolves.toEqual(docIntent);
    await expect(admitSessionContextIntentV1(intent, async () => null))
      .rejects.toMatchObject({ code: 'attachment_unavailable', reason: 'not_found' });
  });
  it('edits only selected entries and local inherited switches, preserving stored placements and Notes', () => {
    const metadata = { summary: { text: 'Keep title', updatedAt: 1 }, work: { memoryEnabled: false,
      sessionRolesV1: { overrides: {}, sessionRoles: {}, notes: 'Keep notes' },
      promptStack: [{ id: 'first', ref: { kind: 'doc', artifactId: 'shared-doc' }, enabled: true, placement: 'composer_insert', maxChars: 12 }],
    } };
    const attached = writeSessionContextIntentV1ToMetadata(metadata, SessionContextIntentV1Schema.parse({ kind: 'attach', entry: {
      id: 'second', ref: { kind: 'doc', artifactId: 'shared-doc' }, enabled: true,
    } }));
    const disabled = writeSessionContextIntentV1ToMetadata(attached, { kind: 'inherited_enable', entryId: 'first', enabled: false });
    expect(disabled.work).toMatchObject({ memoryEnabled: false, disabledInheritedEntryIds: ['first'],
      sessionRolesV1: metadata.work.sessionRolesV1, promptStack: [metadata.work.promptStack[0], { id: 'second', placement: 'system_append', enabled: true }] });
    const moved = writeSessionContextIntentV1ToMetadata(disabled, { kind: 'reorder', entryId: 'second', siblingId: 'first', position: 'before' });
    const cleared = writeSessionContextIntentV1ToMetadata(moved, { kind: 'set_budget', entryId: 'first', maxChars: null });
    expect(cleared.work.promptStack.map((entry) => entry.id)).toEqual(['second', 'first']);
    expect(cleared.work.promptStack[1]).not.toHaveProperty('maxChars');
    expect(cleared.work.promptStack[1]).toHaveProperty('placement', 'composer_insert');
    expect(cleared.summary).toEqual(metadata.summary);
    expect(() => writeSessionContextIntentV1ToMetadata(attached, SessionContextIntentV1Schema.parse({ kind: 'attach', entry: {
      id: 'first', ref: { kind: 'doc', artifactId: 'different-doc' },
    } }))).toThrow('entry_conflict');
  });

  it('refuses new attachment authority fields and non-system placements without rewriting retained entries', () => {
    for (const entry of [
      { id: 'entry', ref: { kind: 'doc', artifactId: 'doc', credentials: 'forged' } },
      { id: 'entry', ref: { kind: 'doc', artifactId: 'doc' }, placement: 'composer_insert' },
    ]) expect(SessionContextIntentV1Schema.safeParse({ kind: 'attach', entry }).success).toBe(false);
  });

  it('reads only the retained Session choice or kind baseline, including malformed-present fail-off', () => {
    expect(readSessionMemoryEnabledV1({})).toBe(false);
    expect(readSessionMemoryEnabledV1({ bot: { kind: 'bot' } })).toBe(true);
    expect(readSessionMemoryEnabledV1({ work: { bot: { kind: 'bot' } } })).toBe(true);
    expect(readSessionMemoryEnabledV1({ bot: { kind: 'bot' }, work: { memoryEnabled: false } })).toBe(false);
    expect(readSessionMemoryEnabledV1({ bot: { kind: 'bot' }, work: { memoryEnabled: 'true' } })).toBe(false);
  });
});
