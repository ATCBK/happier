import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_PUBLIC_PROFILE_POLICY_V1, PublicProfileSnapshotV1Schema } from '@happier-dev/protocol/account/publicProfile';
import { DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1, PublicProfileOwnerReadV1Schema } from '@happier-dev/protocol/account/publicProfilePublication';
import { WidgetDefinitionV1Schema } from '@happier-dev/protocol/widgets';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { describeAuthoredWidgetDefinitionV1 } from '@/components/widgets/widgetCatalog';
import { WidgetSetupPreview } from './WidgetSetupPreview';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
let home: Awaited<ReturnType<typeof serveAccountHomes>> | undefined;
afterEach(async () => { standardCleanup(); await home?.dispose(); home = undefined; });

it('previews the current consented snapshot, never the inline private widget body or Usage pins', async () => {
    const coverage = { status: 'partial', method: 'runtime' } as const;
    const snapshot = PublicProfileSnapshotV1Schema.parse({ v: 1, computedAtMs: 10, coverage, fieldCoverage: {},
        period: { startMs: 1, endMs: 9, timeZoneOffsetMinutes: 0 }, facts: { activeDays: 3 } });
    const owner = PublicProfileOwnerReadV1Schema.parse({ kind: 'ready', context: { handle: 'ada', identity: {}, service: null, urls: null },
        record: { state: 'published', policy: DEFAULT_PUBLIC_PROFILE_POLICY_V1, metadata: {}, projectSelections: [],
            query: { period: { relative: '90days' } }, snapshot, layout: { v: 1, items: [] }, appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1,
            updatedAtMs: 1, publishedAtMs: 1, restriction: null } });
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://setup-preview.test', accountId: 'a' }],
        route: request => request.path === '/v1/account/public-profile' ? Response.json(owner) : undefined });
    const serverId = home.homes.a!.id;
    const definition = WidgetDefinitionV1Schema.parse({ v: 1, id: 'external-days', name: 'Days', sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' },
        inputs: { fields: [] }, inputSchema: { type: 'object', additionalProperties: false }, provenance: { source: { kind: 'authored' } },
        body: { kind: 'declarative', document: { version: 1, root: { kind: 'text', text: 'PRIVATE EXECUTABLE SENTINEL' } } },
        publicPresentation: { kind: 'declarative', document: { version: 1, root: { kind: 'metric', label: 'Shared days',
            data: { kind: 'value', value: { kind: 'public_profile' } }, value: { path: ['snapshot', 'facts', 'activeDays'], type: 'number' } } } } });
    const candidate = describeAuthoredWidgetDefinitionV1(definition, { kind: 'inline', definition });
    const screen = await renderScreen(<WidgetSetupPreview scope={{ serverId, accountId: 'a', owner: {
        kind: 'corePage', pageId: 'public-profile', area: 'main', layoutId: 'minimal' } }} providedContext={{}}
        candidate={candidate} draft={{ bindings: {}, size: 'medium' }} testID="public-setup-preview" />);
    await vi.waitFor(() => expect(screen.getTextContent()).toContain('3'));
    expect(screen.getTextContent()).not.toContain('PRIVATE EXECUTABLE SENTINEL');
    expect(home.requests.some(request => request.path === '/v2/usage/query'
        || request.path.startsWith('/v1/account/public-profile') && request.method !== 'GET')).toBe(false);
});
