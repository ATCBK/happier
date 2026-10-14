import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { installCapabilitiesOpsModuleMock } from '@/dev/testkit/mocks/capabilities';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { buildDynamicModelProbeCacheKey } from '@/sync/domains/models/dynamicModelProbeCacheKey';
import {
    resetDynamicModelProbeCacheForTests,
    writeDynamicModelProbeCacheSuccess,
} from '@/sync/domains/models/dynamicModelProbeCache';
import { installNewSessionComponentsCommonModuleMocks } from './newSessionComponentsTestHelpers';

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

describe('NewSessionEngineOptionDetail Codex catalog arrival', () => {
    beforeEach(() => {
        machineRpc.mockReset();
        resetDynamicModelProbeCacheForTests();
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
