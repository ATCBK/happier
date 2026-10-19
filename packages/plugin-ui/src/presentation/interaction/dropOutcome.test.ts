import { describe, expect, it } from 'vitest';

import { describeHappierDropOutcome, describeHappierSettledDrop, resolveHappierStagedMoveHints, type HappierDropOutcomeVocabulary } from './dropOutcome.js';

const vocabulary: HappierDropOutcomeVocabulary = {
  pendingTitle: (effect) => `Putting under ${effect.preview.target}…`,
  pendingDetail: 'Waiting',
  refusedTitle: 'Can’t move it here',
  lateRefusalTitle: (effect, item) => `Couldn’t put ${item ?? 'it'} under ${effect.preview.target}`,
  unknownTitle: (effect) => `Not sure “${effect.preview.verb}” went through`,
  unknownDetail: 'Check in a moment',
  unchangedCodes: new Set(['already_here']),
  silentCodes: new Set(['no-target']),
};

const relation = { status: 'allowed' as const, effect: { actionId: 'relation.set', input: {}, preview: { verb: 'Put under Fix', target: 'Fix', consequence: 'Both keep running', glyph: 'nest' as const } } };
const plugin = { status: 'allowed' as const, effect: { actionId: 'plugin.link', input: {}, preview: { verb: 'Link to release', target: 'Release' } } };

describe('describeHappierDropOutcome', () => {
  it('preserves a plugin-declared mark through carry, pending and unknown settlement independently of Action ids', () => {
    const admission = { ...plugin, effect: { ...plugin.effect, preview: { ...plugin.effect.preview, glyph: 'copy' as const } } };
    for (const phase of ['carrying', 'pending'] as const) {
      expect(describeHappierDropOutcome({ phase, admission }, vocabulary)?.glyph).toBe('copy');
    }
    expect(describeHappierSettledDrop({ phase: 'settled', admission,
      outcome: { status: 'unknown', reason: { code: 'unknown', message: 'unknown' } } }, vocabulary)?.glyph).toBe('copy');
  });
  it('says the effect, its mark and its limit while carrying, defaulting unknown effects to add', () => {
    expect(describeHappierDropOutcome({ phase: 'carrying', admission: relation }, vocabulary))
      .toEqual({ tone: 'allowed', glyph: 'nest', title: 'Put under Fix', detail: 'Both keep running' });
    expect(describeHappierDropOutcome({ phase: 'carrying', admission: plugin }, vocabulary))
      .toEqual({ tone: 'allowed', glyph: 'add', title: 'Link to release' });
    // A bare verb never stands alone: its unnamed target fills the second line.
    const bare = { status: 'allowed' as const, effect: { actionId: 'plugin.add', input: {}, preview: { verb: 'Add', target: 'Board' } } };
    expect(describeHappierDropOutcome({ phase: 'carrying', admission: bare }, vocabulary)).toMatchObject({ title: 'Add', detail: 'Board' });
  });

  it('keeps a released effect visibly uncommitted until its owner answers', () => {
    expect(describeHappierDropOutcome({ phase: 'pending', admission: relation }, vocabulary))
      .toEqual({ tone: 'pending', glyph: 'nest', title: 'Putting under Fix…', detail: 'Waiting' });
  });

  it('refuses with the owner reason, stays quiet for already-here and silent over nothing', () => {
    const refused = (code: string, preview?: { verb: string; target: string; glyph?: 'refused' }) => ({ status: 'refused' as const, reason: { code, message: 'Because' }, ...(preview ? { preview } : {}) });
    expect(describeHappierDropOutcome({ phase: 'carrying', admission: refused('read', { verb: 'Can’t put under Fix', target: 'Fix', glyph: 'refused' }) }, vocabulary))
      .toEqual({ tone: 'refused', title: 'Can’t put under Fix', detail: 'Because' });
    expect(describeHappierDropOutcome({ phase: 'carrying', admission: refused('read') }, vocabulary)?.title).toBe('Can’t move it here');
    expect(describeHappierDropOutcome({ phase: 'carrying', admission: refused('already_here') }, vocabulary))
      .toMatchObject({ tone: 'quiet', glyph: 'here' });
    expect(describeHappierDropOutcome({ phase: 'carrying', admission: refused('no-target') }, vocabulary)).toBeNull();
  });

  it('lets localized refusal vocabulary describe an action preview without changing allowed or unchanged wording', () => {
    const preview = { verb: 'Move to Project', target: 'Project', glyph: 'move' as const };
    const words = { ...vocabulary, refusedPreviewTitle: (value: { target: string }) => `Can’t move to ${value.target}` };
    const refusal = (code: string) => ({ status: 'refused' as const, reason: { code, message: 'Because' }, preview });
    // Hosted vocabularies without a specific formatter still describe a denial, never the action.
    expect(describeHappierDropOutcome({ phase: 'carrying', admission: refusal('read') }, vocabulary))
      .toEqual({ tone: 'refused', title: vocabulary.refusedTitle, detail: 'Because' });
    for (const phase of ['carrying', 'settled'] as const) {
      expect(describeHappierDropOutcome({ phase, admission: refusal('read') }, words))
        .toEqual({ tone: 'refused', title: 'Can’t move to Project', detail: 'Because' });
    }
    expect(describeHappierDropOutcome({ phase: 'carrying', admission: refusal('already_here') }, words))
      .toEqual({ tone: 'quiet', glyph: 'here', title: preview.verb, detail: 'Because' });
    expect(describeHappierDropOutcome({ phase: 'carrying', admission: { status: 'allowed', effect: { ...plugin.effect, preview } } }, words)?.title)
      .toBe(preview.verb);
  });

  it('words a late refusal and an unknown result the way the source line keeps them, never as a rollback', () => {
    const late = { phase: 'settled' as const, admission: relation, outcome: { status: 'refused' as const, reason: { code: 'changed', message: 'This session was just moved. Try again' } } };
    expect(describeHappierDropOutcome(late, vocabulary, 'Review'))
      .toEqual({ tone: 'refused', title: 'Couldn’t put Review under Fix', detail: 'This session was just moved. Try again' });
    expect(describeHappierSettledDrop(late, vocabulary, 'Review'))
      .toEqual({ kind: 'refused', glyph: 'nest', title: 'Couldn’t put Review under Fix', detail: 'This session was just moved. Try again' });
    const unknown = { ...late, outcome: { status: 'unknown' as const, reason: { code: 'effect-outcome-unknown', message: 'x' } } };
    expect(describeHappierSettledDrop(unknown, vocabulary))
      .toEqual({ kind: 'unknown', glyph: 'nest', title: 'Not sure “Put under Fix” went through', detail: 'Check in a moment' });
    expect(describeHappierDropOutcome(unknown, vocabulary)?.tone).toBe('quiet');
  });

  it('has nothing to keep once an effect applied or when a refusal came before dispatch', () => {
    const applied = { phase: 'settled' as const, admission: relation, outcome: { status: 'applied' as const } };
    expect(describeHappierDropOutcome(applied, vocabulary)).toBeNull();
    expect(describeHappierSettledDrop(applied, vocabulary)).toBeNull();
    const early = { phase: 'settled' as const, admission: { status: 'refused' as const, reason: { code: 'read', message: 'Because' } }, outcome: { status: 'refused' as const, reason: { code: 'read', message: 'Because' } } };
    expect(describeHappierSettledDrop(early, vocabulary)).toBeNull();
    expect(describeHappierDropOutcome(early, vocabulary)).toMatchObject({ tone: 'refused', detail: 'Because' });
  });
});

describe('resolveHappierStagedMoveHints', () => {
  it('draws one key convention, nesting keys only where the list nests and mirrored for right-to-left', () => {
    const labels = { choose: 'Choose', drop: 'Drop', cancel: 'Cancel', escapeKey: 'esc' };
    expect(resolveHappierStagedMoveHints({ labels })).toEqual([
      { keys: ['↑', '↓'], label: 'Choose' }, { keys: ['↵'], label: 'Drop' }, { keys: ['esc'], label: 'Cancel' },
    ]);
    expect(resolveHappierStagedMoveHints({ labels: { ...labels, in: 'Put under', out: 'Top level' }, rtl: true }).slice(1, 3))
      .toEqual([{ keys: ['←'], label: 'Put under' }, { keys: ['→'], label: 'Top level' }]);
  });
});
