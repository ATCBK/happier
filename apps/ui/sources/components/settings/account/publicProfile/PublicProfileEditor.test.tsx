import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PUBLIC_PROFILE_POLICY_V1,
  PublicProfileSnapshotV1Schema,
} from '@happier-dev/protocol/account/publicProfile';
import { projectPublicProfile } from '@happier-dev/protocol/account/projectPublicProfile';
import {
  DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1,
  PublicProfileLayoutV1Schema,
} from '@happier-dev/protocol/account/publicProfilePublication';

import { renderScreen } from '@/dev/testkit';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import {
  PublicProfileEditor,
  type PublicProfileEditorProps,
} from './PublicProfileEditor';
import { PublicProfileReview } from './PublicProfileReview';

const coverage = {
  status: 'complete_for_supplied_facts',
  method: 'runtime',
} as const;
const snapshot = PublicProfileSnapshotV1Schema.parse({
  v: 1,
  computedAtMs: 10,
  coverage,
  fieldCoverage: {},
  period: { startMs: 1, endMs: 9, timeZoneOffsetMinutes: 0 },
  facts: { tokens: 87654321, activeDays: 3 },
});
const context = {
  handle: 'leeroy',
  identity: { name: 'Leeroy Brun' },
  service: {
    displayName: 'Happier Cloud',
    publicBaseUrl: 'https://happier.dev',
  },
  urls: {
    page: 'https://happier.dev/@leeroy',
    json: 'https://happier.dev/v1/public/profiles/leeroy',
    badgeBase: 'https://happier.dev/@leeroy/badge',
    card: 'https://happier.dev/@leeroy/card.svg',
    og: 'https://happier.dev/@leeroy/og.png',
    report: 'mailto:ops@happier.dev',
  },
};
const metric = (id: string, field: string) =>
  ({
    kind: 'widget',
    id,
    size: 'medium',
    frameStyle: 'card',
    title: id,
    presentation: {
      kind: 'declarative',
      document: {
        version: 1,
        root: {
          kind: 'metric',
          label: id,
          data: { kind: 'value', value: { kind: 'public_profile' } },
          value: { path: ['snapshot', 'facts', field], type: 'number' },
        },
      },
    },
  }) as const;
const layout = PublicProfileLayoutV1Schema.parse({
  v: 1,
  items: [metric('tokens', 'tokens'), metric('days', 'activeDays')],
});
const view = (tokens: boolean) =>
  projectPublicProfile({
    context,
    metadata: {},
    snapshot,
    layout,
    appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1,
    policy: {
      ...DEFAULT_PUBLIC_PROFILE_POLICY_V1,
      fields: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields, tokens },
    },
  })!;
const pageLabels = {
  identityLine: '@leeroy',
  periodTitle: 'Last 90 days',
  periodDetail: 'Jul – Oct',
  emptyLayout: 'Empty',
  footerNote: 'Note',
  report: 'Report',
  madeWith: 'Made with Happier',
  inert: { success: 's', warning: 'w', error: 'e', incomplete: 'i' },
};

const isDisabled = (
  node: {
    props: { disabled?: unknown; accessibilityState?: { disabled?: unknown } };
  } | null,
) => Boolean(node?.props.disabled ?? node?.props.accessibilityState?.disabled);

function editor(overrides: Partial<PublicProfileEditorProps> = {}) {
  return (
    <PublicProfileEditor
      status="draft"
      mode="edit"
      onModeChange={() => {}}
      changes={0}
      ownerView={view(true)}
      visitorView={view(false)}
      hiddenBlockIds={new Set(['tokens'])}
      pageLabels={pageLabels}
      notice={null}
      submitting={false}
      onSubmit={() => {}}
      renderTools={() => null}
      {...overrides}
    />
  );
}

describe('PublicProfileEditor', () => {
  it('arranges the owner’s widget area in place on Edit, also before a preview exists, and shows visitors’ blocks on Preview', async () => {
    const area = () => <Text testID="owner-area">area</Text>;
    const edit = await renderScreen(editor({ renderEditBlocks: area }));
    expect(edit.findByTestId('owner-area')).not.toBeNull();
    expect(edit.findByTestId('public-profile-block-days')).toBeNull();
    const unprepared = await renderScreen(editor({ renderEditBlocks: area, ownerView: null, notice: 'Usage is locked' }));
    expect(unprepared.findByTestId('owner-area')).not.toBeNull();
    expect(unprepared.findByTestId('public-profile-editor-preparing')).toBeNull();
    const preview = await renderScreen(editor({ renderEditBlocks: area, mode: 'preview' }));
    expect(preview.findByTestId('owner-area')).toBeNull();
    expect(preview.findByTestId('public-profile-block-days')).not.toBeNull();
  });

  it('shows the owner every placed block, marking private ones, and visitors only what is shared', async () => {
    const edit = await renderScreen(editor());
    expect(edit.findByTestId('public-profile-block-tokens')).not.toBeNull();
    expect(edit.getTextContent()).toContain(t('publicIdentity.editor.onlyYou'));
    const preview = await renderScreen(editor({ mode: 'preview' }));
    expect(preview.findByTestId('public-profile-block-tokens')).toBeNull();
    expect(preview.findByTestId('public-profile-block-days')).not.toBeNull();
    expect(preview.getTextContent()).not.toContain(
      t('publicIdentity.editor.onlyYou'),
    );
  });

  it('offers Publish before the first publication and Apply only once something changed', async () => {
    const onSubmit = vi.fn();
    const first = await renderScreen(editor({ onSubmit }));
    expect(first.getTextContent()).toContain(
      t('publicIdentity.editor.publish'),
    );
    expect(first.getTextContent()).not.toContain(
      t('publicIdentity.editor.apply'),
    );
    await first.pressByTestIdAsync('public-profile-editor-submit');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const unchanged = await renderScreen(
      editor({ status: 'published', changes: 0 }),
    );
    expect(
      isDisabled(unchanged.findByTestId('public-profile-editor-submit')),
    ).toBe(true);
    const changed = await renderScreen(
      editor({ status: 'published', changes: 2 }),
    );
    expect(changed.getTextContent()).toContain(
      t('publicIdentity.editor.apply'),
    );
    expect(
      isDisabled(changed.findByTestId('public-profile-editor-submit')),
    ).toBe(false);
    expect(changed.getTextContent()).toContain(
      t('publicIdentity.editor.hintChanges', { count: 2 }),
    );
  });

  it('disables Publish and Apply until the selected private area has a current compiled candidate', async () => {
    for (const status of ['draft', 'published'] as const) {
      const screen = await renderScreen(editor({ status, changes: 1, canSubmit: false }));
      expect(isDisabled(screen.findByTestId('public-profile-editor-submit'))).toBe(true);
    }
  });
});

describe('PublicProfileReview', () => {
  const review = (
    overrides: Partial<React.ComponentProps<typeof PublicProfileReview>> = {},
  ) => (
    <PublicProfileReview
      kind="publish"
      service="Happier Cloud"
      pageUrl="https://happier.dev/@leeroy"
      period="Jul – Oct"
      sharedFields={['tokens', 'calendar']}
      disclosure={view(true)}
      endToEndEncrypted
      indexable={false}
      confirming={false}
      onConfirm={() => {}}
      onCancel={() => {}}
      {...overrides}
    />
  );

  it('names every item that becomes public, the plaintext and picture consequences, and confirms once', async () => {
    const onConfirm = vi.fn();
    const screen = await renderScreen(
      review({ onConfirm, renderPicture: () => null }),
    );
    const text = screen.getTextContent();
    expect(text).toContain(t('publicIdentity.publicData.fields.tokens'));
    expect(text).toContain(t('publicIdentity.publicData.fields.calendar'));
    expect(text).toContain(t('publicIdentity.review.plaintext'));
    expect(text).toContain(t('publicIdentity.review.picture'));
    await screen.pressByTestIdAsync('public-profile-review-confirm');
    expect(onConfirm).toHaveBeenCalledTimes(1);
    const plain = await renderScreen(
      review({ kind: 'apply', sharedFields: [], endToEndEncrypted: false }),
    );
    expect(plain.getTextContent()).not.toContain(
      t('publicIdentity.review.plaintext'),
    );
    expect(plain.getTextContent()).not.toContain(
      t('publicIdentity.review.picture'),
    );
    expect(plain.getTextContent()).toContain(t('publicIdentity.review.none'));
  });

  it('shows the retained picture copy that Confirm sends, not only a warning', async () => {
    const screen = await renderScreen(
      review({ renderPicture: () => <Text testID="retained-copy">copy</Text> }),
    );
    expect(screen.findByTestId('retained-copy')).not.toBeNull();
  });

  it('warns that weekly agent mix with public Tokens lets visitors estimate weekly per-agent amounts', async () => {
    const joint = await renderScreen(
      review({ sharedFields: ['tokens', 'weeklyAgentMix'] }),
    );
    expect(joint.getTextContent()).toContain(
      t('publicIdentity.publicData.details.weeklyAgentMix'),
    );
    const tokensHidden = await renderScreen(
      review({ sharedFields: ['weeklyAgentMix'] }),
    );
    expect(tokensHidden.getTextContent()).not.toContain(
      t('publicIdentity.publicData.details.weeklyAgentMix'),
    );
    expect(tokensHidden.getTextContent()).toContain(
      t('publicIdentity.publicData.fields.tokens'),
    );
  });

  it('discloses the exact public data on demand', async () => {
    const screen = await renderScreen(review({ sharedFields: ['tokens'] }));
    expect(screen.getTextContent()).not.toContain('87654321');
    await screen.pressByTestIdAsync('public-profile-review-data');
    expect(screen.getTextContent()).toContain('87654321');
  });
});
