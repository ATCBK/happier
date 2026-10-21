import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_PUBLIC_PROFILE_POLICY_V1, PublicProfileSnapshotV1Schema } from '@happier-dev/protocol/account/publicProfile';
import { projectPublicProfile } from '@happier-dev/protocol/account/projectPublicProfile';
import { DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1, PublicProfileLayoutV1Schema } from '@happier-dev/protocol/account/publicProfilePublication';

import { renderScreen } from '@/dev/testkit';
import { t } from '@/text';
import { PublicProfileEditor, type PublicProfileEditorProps } from './PublicProfileEditor';
import { PublicProfileReview } from './PublicProfileReview';

const coverage = { status: 'complete_for_supplied_facts', method: 'runtime' } as const;
const snapshot = PublicProfileSnapshotV1Schema.parse({ v: 1, computedAtMs: 10, coverage, fieldCoverage: {},
  period: { startMs: 1, endMs: 9, timeZoneOffsetMinutes: 0 }, facts: { tokens: 87654321, activeDays: 3 } });
const context = { handle: 'leeroy', identity: { name: 'Leeroy Brun' }, service: { displayName: 'Happier Cloud', publicBaseUrl: 'https://happier.dev' },
  urls: { page: 'https://happier.dev/@leeroy', json: 'https://happier.dev/v1/public/profiles/leeroy', badgeBase: 'https://happier.dev/@leeroy/badge',
    card: 'https://happier.dev/@leeroy/card.svg', og: 'https://happier.dev/@leeroy/og.png', report: 'mailto:ops@happier.dev' } };
const metric = (id: string, field: string) => ({ kind: 'widget', id, size: 'medium', frameStyle: 'card', title: id, presentation: { kind: 'declarative',
  document: { version: 1, root: { kind: 'metric', label: id, data: { kind: 'value', value: { kind: 'public_profile' } }, value: { path: ['snapshot', 'facts', field], type: 'number' } } } } }) as const;
const layout = PublicProfileLayoutV1Schema.parse({ v: 1, items: [metric('tokens', 'tokens'), metric('days', 'activeDays')] });
const view = (tokens: boolean) => projectPublicProfile({ context, metadata: {}, snapshot, layout, appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1,
  policy: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1, fields: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields, tokens } } })!;
const pageLabels = { identityLine: '@leeroy', periodTitle: 'Last 90 days', periodDetail: 'Jul – Oct', emptyLayout: 'Empty', footerNote: 'Note',
  report: 'Report', madeWith: 'Made with Happier', inert: { success: 's', warning: 'w', error: 'e', incomplete: 'i' } };

const isDisabled = (node: { props: { disabled?: unknown; accessibilityState?: { disabled?: unknown } } } | null) =>
  Boolean(node?.props.disabled ?? node?.props.accessibilityState?.disabled);

function editor(overrides: Partial<PublicProfileEditorProps> = {}) {
  return <PublicProfileEditor status="draft" mode="edit" onModeChange={() => {}} changes={0} ownerView={view(true)} visitorView={view(false)}
    hiddenBlockIds={new Set(['tokens'])} pageLabels={pageLabels} notice={null} submitting={false} onSubmit={() => {}}
    renderTools={() => null} {...overrides} />;
}

describe('PublicProfileEditor', () => {
  it('shows the owner every placed block, marking private ones, and visitors only what is shared', async () => {
    const edit = await renderScreen(editor());
    expect(edit.findByTestId('public-profile-block-tokens')).not.toBeNull();
    expect(edit.getTextContent()).toContain(t('publicIdentity.editor.onlyYou'));
    const preview = await renderScreen(editor({ mode: 'preview' }));
    expect(preview.findByTestId('public-profile-block-tokens')).toBeNull();
    expect(preview.findByTestId('public-profile-block-days')).not.toBeNull();
    expect(preview.getTextContent()).not.toContain(t('publicIdentity.editor.onlyYou'));
  });

  it('offers Publish before the first publication and Apply only once something changed', async () => {
    const onSubmit = vi.fn();
    const first = await renderScreen(editor({ onSubmit }));
    expect(first.getTextContent()).toContain(t('publicIdentity.editor.publish'));
    expect(first.getTextContent()).not.toContain(t('publicIdentity.editor.apply'));
    await first.pressByTestIdAsync('public-profile-editor-submit');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const unchanged = await renderScreen(editor({ status: 'published', changes: 0 }));
    expect(isDisabled(unchanged.findByTestId('public-profile-editor-submit'))).toBe(true);
    const changed = await renderScreen(editor({ status: 'published', changes: 2 }));
    expect(changed.getTextContent()).toContain(t('publicIdentity.editor.apply'));
    expect(isDisabled(changed.findByTestId('public-profile-editor-submit'))).toBe(false);
    expect(changed.getTextContent()).toContain(t('publicIdentity.editor.hintChanges', { count: 2 }));
  });
});

describe('PublicProfileReview', () => {
  it('names every item that becomes public, the plaintext and picture consequences, and confirms once', async () => {
    const onConfirm = vi.fn();
    const screen = await renderScreen(<PublicProfileReview kind="publish" service="Happier Cloud" sharedFields={['tokens', 'calendar']}
      endToEndEncrypted uploadsPicture indexable={false} confirming={false} onConfirm={onConfirm} onCancel={() => {}} />);
    const text = screen.getTextContent();
    expect(text).toContain(t('publicIdentity.publicData.fields.tokens'));
    expect(text).toContain(t('publicIdentity.publicData.fields.calendar'));
    expect(text).toContain(t('publicIdentity.review.plaintext'));
    expect(text).toContain(t('publicIdentity.review.picture'));
    await screen.pressByTestIdAsync('public-profile-review-confirm');
    expect(onConfirm).toHaveBeenCalledTimes(1);
    const plain = await renderScreen(<PublicProfileReview kind="apply" service="Happier Cloud" sharedFields={[]}
      endToEndEncrypted={false} uploadsPicture={false} indexable={false} confirming={false} onConfirm={() => {}} onCancel={() => {}} />);
    expect(plain.getTextContent()).not.toContain(t('publicIdentity.review.plaintext'));
    expect(plain.getTextContent()).not.toContain(t('publicIdentity.review.picture'));
    expect(plain.getTextContent()).toContain(t('publicIdentity.review.none'));
  });
});
