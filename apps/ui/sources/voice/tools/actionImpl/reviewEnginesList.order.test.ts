import * as React from 'react';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountSettingsSchema } from '@happier-dev/protocol';
import { ReviewEngineListItemSchema } from '@happier-dev/protocol/reviews/reviewEngines';
import { z } from 'zod/mini';
import { ACP_CATALOG_ROWS_ROUTE_V1, AcpCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { createMachineFixture, createPlainMachineRowFixture, createReadyMachineAgentInventoryFixture, standardCleanup, waitForTestEvent } from '@/dev/testkit';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { createSessionFilesViewFixture, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from '@/components/sessions/files/views/sessionFilesViewTestkit';

installSessionFilesViewBoundaries();
await prepareSessionFilesViewTestkit();
const { StartReviewDialog } = await import('@/components/sessions/reviews/walkthrough/StartReviewDialog');
let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>>;
afterEach(async () => { standardCleanup(); await fixture?.dispose(); });

describe('Review inventory order through Start selection', () => {
    it.each([
        { disabled: false, preselected: undefined, expected: 'claude' },
        { disabled: true, preselected: undefined, expected: 'codex' },
        { disabled: false, preselected: ['antigravity'], expected: 'antigravity' },
    ])('keeps catalog preference and explicit retry selection ($expected, disabled=$disabled)', async ({ disabled, preselected, expected }) => {
        // The daemon producer and UI consumer share their real public inventory. Only HTTP is replaced.
        // Load the other host at runtime: each host's @ alias belongs to its own compiler project.
        // The public inventory schema admits the output at this cross-program test boundary.
        const producerPath = fileURLToPath(new URL('../../../../../cli/src/session/actions/inventory/buildReviewEngineInventoryItems.ts', import.meta.url));
        const producer: unknown = await import(/* @vite-ignore */ producerPath);
        if (!producer || typeof producer !== 'object' || !('buildReviewEngineInventoryItems' in producer)
            || typeof producer.buildReviewEngineInventoryItems !== 'function') throw new Error('Review inventory producer unavailable');
        const items = z.array(ReviewEngineListItemSchema).parse(await producer.buildReviewEngineInventoryItems({
            includeDisabled: true,
            accountSettings: AccountSettingsSchema.parse({ backendEnabledByTargetKey: disabled
                ? { 'agent:happier.agent.claude/claude': false } : {} }),
            acpCatalogSnapshot: { status: 'ready', revision: 1, record: { v: 1, definitions: [] } },
        }));
        const inventoryBoundary = await createExternalActionAccountHttpBoundary({
            serverUrl: 'https://session-file-views.test', serverIdentityId: 'srv_review_order', accountId: 'alice',
            machineId: 'm1', tokenEpoch: 0, actionId: 'review.engines.list', requesterInvocation: 'none',
            execute: () => ({ sessionId: null, items }),
        });
        const machineInventory = createReadyMachineAgentInventoryFixture(items.map(item => ({ agentId: item.engineId, title: item.label })));
        fixture = await createSessionFilesViewFixture({ rootPath: '/repo',
            credentials: { token: createAccountTokenForTests('alice', { currentAccount: true }) }, serverIdentityId: 'srv_review_order',
            machine: createMachineFixture({ id: 'm1', kind: 'persistent', revokedAt: null, replacedByMachineId: null,
                installationId: 'test-installation', storageMode: 'plain', access: createPlainMachineRowFixture({ id: 'm1', accountId: 'alice' }).access }),
            rpc: async ({ method }) => method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
                ? { protocolVersion: 1, projection: machineInventory.projection }
                : method === RPC_METHODS.CAPABILITIES_DETECT ? machineInventory.capabilities
                : { success: false, error: 'RPC method not available', errorCode: 'METHOD_NOT_AVAILABLE' },
            request: async (url, init) => {
                const path = new URL(String(url)).pathname;
                if (path === ACP_CATALOG_ROWS_ROUTE_V1) return Response.json(AcpCatalogRowReadResponseV1Schema.parse({
                    status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, definitions: [] } },
                }));
                return await inventoryBoundary.handle(new URL(String(url)), init) ?? Response.json({}, { status: 404 });
            },
        });
        const screen = await fixture.render(React.createElement(StartReviewDialog, {
            sessionId: 's1', serverId: fixture.home.id, cwd: '/repo',
            comparison: { kind: 'workingTree' }, comparisonId: 'comparison-1', scopeLabel: 'Pending changes',
            defaultWalkthrough: true, preselectedEngineIds: preselected, onClose: vi.fn(), onStarted: vi.fn(),
        }));
        await waitForTestEvent(screen.subscribe, () => screen.findByTestId(`start-review-engine-${expected}`)?.props.accessibilityState?.checked,
            checked => checked === true);
        expect(screen.findByTestId(`start-review-engine-${expected}`)?.props.accessibilityState?.checked).toBe(true);
        expect(items.slice(0, 5).map(item => item.engineId)).toEqual(['claude', 'codex', 'opencode', 'antigravity', 'gemini']);
        if (expected !== 'antigravity') expect(screen.findByTestId('start-review-engine-antigravity')?.props.accessibilityState?.checked).toBe(false);
    });
});
