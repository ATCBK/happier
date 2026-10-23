import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PROMPT_LIBRARY_ROWS_ROUTE_V1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { SessionListQueryResponseV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import type { CustomModalInjectedProps } from '@/modal/types';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainSessionByIdResponseFixture, createSessionFixture, createSessionOwnerViewerFixture } from '@/dev/testkit/fixtures/sessionFixtures';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: key => key }));

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { getStorage } = await import('@/sync/domains/state/storage');
const { MakeCoordinatorDialog } = await import('./MakeCoordinatorDialog');
const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
const previous = getStorage().getState();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let serverId: string;

beforeEach(async () => {
    await homes.reset();
    const serverUrl = 'https://coordinator-rules-demand.test';
    serverId = await homes.addHome({ name: 'Coordinator', serverUrl, accountId: 'alice', currentAccount: true });
    homes.answer(serverId, '/v2/account/session-follow-rules', { body: { rules: [] } });
    homes.answer(serverId, '/v2/account/session-follow-preferences', { body: { assigned: true, direct: false, team: false, group: false } });
    homes.answer(serverId, PROMPT_LIBRARY_ROWS_ROUTE_V1, { body: { status: 'listed', rows: [{
        key: 'role-overrides', revision: 1,
        content: { t: 'plain', v: { key: 'role-overrides', value: { v: 1, overrides: {} } } },
    }] } });
    connection = await restoreServerAccountForTest({ serverUrl, accountId: 'alice',
        credentials: { token: createAccountTokenForTests('alice', { currentAccount: true }) }, request: homes.request });
    const { sync } = await import('@/sync/sync');
    await sync.awaitBootstrapForegroundAcquisition();
    const session = createSessionFixture({ id: 'coordinator', serverId,
        metadata: { path: '/work/payments', host: 'test', projectId: 'payments' } });
    getStorage().setState(state => ({ sessions: { coordinator: session }, settings: { ...state.settings,
        coordinationCoordinatorSuggestProjectRule: true, coordinationCoordinatorSuggestHomeRule: true } }));
    homes.answer(serverId, '/v2/sessions/coordinator', { body: createPlainSessionByIdResponseFixture(session) });
    homes.answer(serverId, '/v2/sessions/query', { body: SessionListQueryResponseV1Schema.parse({
        sessions: [{ ...createPlainSessionByIdResponseFixture(session).session, viewer: createSessionOwnerViewerFixture(session) }],
        hasNext: false, nextCursor: null, attentionHasNext: false, attentionNextCursor: null,
    }) });
});
afterEach(async () => {
    standardCleanup();
    await connection?.dispose(); connection = undefined;
    getStorage().setState(previous, true);
});

it('reads the private rule census once per Make coordinator open for suggestions, Managed by and overlap', async () => {
    const ruleReads = () => homes.requests.filter(request => request.path === '/v2/account/session-follow-rules').length;
    for (let open = 0; open < 2; open++) {
        const baseline = ruleReads();
        const closed = vi.fn();
        function Host() {
            const [visible, setVisible] = React.useState(true);
            const [chrome, setChrome] = React.useState<Parameters<NonNullable<CustomModalInjectedProps['setChrome']>>[0]>(null);
            const close = React.useCallback(() => { closed(); setVisible(false); }, []);
            return <>{visible ? <MakeCoordinatorDialog serverId={serverId} sessionId="coordinator" onClose={close} setChrome={setChrome} /> : null}
                {visible && chrome?.kind === 'card' ? chrome.footer : null}</>;
        }
        const screen = await renderScreen(<Host />);
        await waitForHomeGovernance(() => {
            for (const scope of ['project', 'home']) {
                const row = screen.findAll(node => node.props.testID === `make-coordinator-rule-${scope}` && node.props.subtitle !== undefined)[0];
                expect(row).toBeDefined();
                expect(['sessionCoordinator.make.count', 'sessionCoordinator.make.countAtLeast']).toContain(row?.props.subtitle);
            }
        });
        expect(ruleReads() - baseline).toBe(1);
        await act(async () => {
            for (let index = 0; index < 1_000; index++) publishHomeAccountChange(serverId, [`unrelated-${index}`], { changeKinds: ['artifact'] });
        });
        expect(ruleReads() - baseline).toBe(1);
        await act(async () => screen.pressByTestId('make-coordinator-cancel'));
        expect(closed).toHaveBeenCalledOnce();
        await screen.unmount();
        expect(ruleReads() - baseline).toBe(1);
    }
});
