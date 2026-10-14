import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { AcpCatalogRecordV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

afterEach(() => standardCleanup());

it('renders the canonical ACP glyph for a configured Agent without a package brand', async () => {
    const { resolveConfiguredAcpAgentCatalogProjection } = await import('@/agents/backendCatalog/agentCatalogProjection');
    const { AgentCatalogIdentityIcon } = await import('./AgentCatalogIdentityIcon');
    const definition = AcpCatalogRecordV1Schema.parse({ v: 1, definitions: [{
        id: 'review', name: 'review', title: 'Review agent', launch: { kind: 'npm', package: 'fixture', version: '1.0', args: [] },
        env: {}, createdAt: 1, updatedAt: 1,
    }] }).definitions[0]!;
    const entry = resolveConfiguredAcpAgentCatalogProjection(definition, { enabledAgentIds: [] });
    const screen = await renderScreen(<AgentCatalogIdentityIcon entry={entry} current={false}
        machineId={null} serverId={null} testID="configured-agent-mark" />);
    expect(screen.findAll(node => node.props.testID === 'configured-agent-mark' && node.props.name === 'hard-drives')).not.toHaveLength(0);
});
