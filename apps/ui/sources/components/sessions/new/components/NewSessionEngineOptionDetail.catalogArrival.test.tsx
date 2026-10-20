import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { installCapabilitiesOpsModuleMock } from '@/dev/testkit/mocks/capabilities';
import { createResolvedAgentCatalogEntryFixture } from '@/dev/testkit/fixtures/agentCatalogFixtures';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { buildDynamicModelProbeCacheKey } from '@/sync/domains/models/dynamicModelProbeCacheKey';
import {
    resetDynamicModelProbeCacheForTests,
    writeDynamicModelProbeCacheSuccess,
} from '@/sync/domains/models/dynamicModelProbeCache';
import { installNewSessionComponentsCommonModuleMocks } from './newSessionComponentsTestHelpers';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import {
    normalizeNewSessionCapabilityProbeContextCacheKeySuffixParts,
    resolveNewSessionModelCapabilityProbeContext,
} from '@/components/sessions/new/modules/newSessionCapabilityProbeContext';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installNewSessionComponentsCommonModuleMocks();

const machineRpc = vi.hoisted(() => vi.fn());

vi.mock('@/sync/ops/capabilities', (importOriginal) => (
    installCapabilitiesOpsModuleMock({ machineCapabilitiesInvoke: machineRpc })(importOriginal)
));
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
    return {
        ...original,
        createFrontDoorActionExecute: createFrontDoorActionExecuteForVitest(original),
    };
});

const { NewSessionEngineOptionDetail } = await import('./NewSessionEngineOptionDetail');
const { buildSessionAgentPickerDetailContent } = await import('@/components/sessions/agentPicker/buildSessionAgentPickerDetailContent');

describe('NewSessionEngineOptionDetail Codex catalog arrival', () => {
    beforeEach(() => {
        machineRpc.mockReset();
        resetDynamicModelProbeCacheForTests();
    });

    it('names the selected native account or pool through the shared Agent detail builder', async () => {
        machineRpc.mockImplementation(() => new Promise(() => undefined));
        const backendTarget = { kind: 'backend' as const, backendId: 'codex' };
        const probeContext = resolveNewSessionModelCapabilityProbeContext({
            backendTarget,
            settings: settingsDefaults,
            connectedServices: null,
        });
        const cacheKey = buildDynamicModelProbeCacheKey({
            machineId: 'machine-58f6',
            targetKey: resolveBackendTargetKeyV2(backendTarget),
            providerConnectionId: null,
            serverId: 'server-main',
            cwd: '/workspace',
            extraKeySuffixParts: normalizeNewSessionCapabilityProbeContextCacheKeySuffixParts(probeContext),
        });
        expect(cacheKey).not.toBeNull();
        writeDynamicModelProbeCacheSuccess(cacheKey!, {
            availableModels: [{ id: 'gpt-6-luna', name: 'GPT 6 Luna' }],
            supportsFreeform: true,
        });
        const sourceLabel = 'Codex · Work pool';
        const screen = await renderScreen(buildSessionAgentPickerDetailContent({
            backendTarget,
            agentCatalogEntry: createResolvedAgentCatalogEntryFixture({ agentId: 'codex' }),
            selectedMachineId: 'machine-58f6',
            capabilityServerId: 'server-main',
            cwd: '/workspace',
            settings: settingsDefaults,
            connectedServices: null,
            nativeSourceLabel: sourceLabel,
            selection: { modelId: 'default', modelSelection: null, sessionModeId: 'default', configOverrides: {} },
            onSelectionChange: () => {},
        }));
        await flushHookEffects();

        expect(screen.findByTestId('model-picker-overlay-option:["agent:happier.agent.codex/codex",null,"gpt-6-luna"]')).not.toBeNull();
        expect(screen.findAll((node) => typeof node.type === 'string' && node.children.includes(sourceLabel))).not.toHaveLength(0);
    });

    it('keeps the real picker stable when the Codex model catalog arrives asynchronously', async () => {
        machineRpc.mockImplementation(() => new Promise(() => undefined));
        const backendTarget = { kind: 'backend' as const, backendId: 'codex' };
        const cacheKey = buildDynamicModelProbeCacheKey({
            machineId: 'machine-58f6',
            targetKey: resolveBackendTargetKeyV2(backendTarget),
            providerConnectionId: null,
            serverId: 'server-main',
            cwd: '/workspace',
        });
        expect(cacheKey).not.toBeNull();
        writeDynamicModelProbeCacheSuccess(cacheKey!, {
            availableModels: [],
            supportsFreeform: true,
        });

        const screen = await renderScreen(
            <NewSessionEngineOptionDetail
                backendTarget={backendTarget}
                selectedMachineId="machine-58f6"
                capabilityServerId="server-main"
                cwd="/workspace"
                selectedModelId="default"
                selectedSessionModeId="default"
                selectedConfigOverrides={{}}
            />,
        );
        await flushHookEffects();

        await act(async () => {
            writeDynamicModelProbeCacheSuccess(cacheKey!, {
                availableModels: [
                    { id: 'gpt-6-luna', name: 'GPT 6 Luna' },
                    { id: 'catalog-only-codex', name: 'Catalog only Codex' },
                ],
                supportsFreeform: true,
            });
        });

        expect(screen.findByTestId(
            'model-picker-overlay-option:["agent:happier.agent.codex/codex",null,"gpt-6-luna"]',
        )).toBeTruthy();
        expect(screen.findByTestId('model-picker-overlay-custom-input')).toBeNull();
    });
});
