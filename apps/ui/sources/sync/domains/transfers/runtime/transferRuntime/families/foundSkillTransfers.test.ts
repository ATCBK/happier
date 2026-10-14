import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installPromptLibrarySettingsCommonModuleMocks } from '@/components/settings/prompts/promptLibrarySettingsTestHelpers';

vi.mock('socket.io-client', async original => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
vi.mock('@happier-dev/iroh-native', async original => (await import('@/dev/testkit/harness/promptMachineTransferBoundary')).createPromptNativeTransferModuleBoundary(original));
installPromptLibrarySettingsCommonModuleMocks({ storage: original => original(), reactNative: async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'ios', select: ({ ios, default: fallback }: { ios?: unknown; default?: unknown }) => ios ?? fallback } });
} });
const { createHomeGovernanceHarness, installHomeGovernanceBoundaries } = await import('@/dev/testkit/harness/homeGovernanceHarness');
installHomeGovernanceBoundaries(createHomeGovernanceHarness());
const { createPromptLibraryCatalogBoundary } = await import('@/dev/testkit/harness/promptLibraryCatalogBoundary');
const { createPromptMachineTransferFixture, createFoundSkillTransferFixture, installPromptMachineSocketBoundary } = await import('@/dev/testkit/harness/promptMachineTransferBoundary');
installPromptMachineSocketBoundary();
const { storage } = await import('@/sync/domains/state/storage');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
const { readFoundSkillBundle } = await import('./foundSkillTransfers');
const found = createFoundSkillTransferFixture({ name: 'sample', path: '/native/skills/sample', scope: 'user', agents: ['claude'],
    files: [{ path: 'SKILL.md', contentBase64: Buffer.from('---\nname: sample\ndescription: Sample skill\n---\n# Sample').toString('base64'), contentKind: 'utf8', unixMode: 0o644 },
        { path: 'data.bin', contentBase64: Buffer.from([0, 255]).toString('base64'), contentKind: 'binary', unixMode: 0o755 }] });
let fixture: Awaited<ReturnType<typeof createPromptMachineTransferFixture>>;
let previousState: ReturnType<typeof storage.getState>;
beforeEach(async () => { previousState = storage.getState(); const catalog = createPromptLibraryCatalogBoundary();
    fixture = await createPromptMachineTransferFixture({ serverUrl: 'https://found-transfer.test', serverIdentityId: 'srv_found_transfer',
        selectionKey: 'skills.found', foundSkill: found, handleHomeRequest: catalog.handle }); });
afterEach(async () => { await fixture?.dispose(); storage.setState(previousState, true); });

describe('Found reader and real Action mount', () => {
    it('reads strict native skill bytes and modes through the finite transfer without writing', async () => {
        expect(await readFoundSkillBundle('machine-1', found.bundle.path, { serverId: fixture.serverId })).toEqual(found.bundle);
        expect(fixture.artifacts.list()).toEqual([]);
    });
    it('mounts the Found reader in the default Action executor for a read-only compare', async () => {
        const result = await createDefaultActionExecutor().execute('skills.found.read', { machineId: 'machine-1', path: found.bundle.path },
            { surface: 'ui', serverId: fixture.serverId, expectedAccountId: fixture.scope.accountId, authority: 'present_user', actionCaller: { kind: 'host' } });
        expect(result).toEqual({ ok: true, result: { name: found.bundle.name, files: found.bundle.files } });
        expect(fixture.artifacts.list()).toEqual([]);
    });
});
