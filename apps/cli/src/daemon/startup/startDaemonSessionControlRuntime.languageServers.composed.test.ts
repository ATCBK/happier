import { expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { PluginProtocolClientHandle } from '@happier-dev/plugin-sdk/exec/protocol-clients';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createStablePluginExecService } from '@/plugins/runtime/invocation/services/exec';
import { DEFAULT_JSON_RPC_MAX_FRAME_BYTES } from '@/plugins/runtime/exec/jsonRpc';
import { readSupervisedPluginProcessIdForHost } from '@/plugins/runtime/exec/processSupervisor';
import { configureLanguageServerHost, disposeLanguageServerHost, getLanguageServerHost } from '@/lsp/languageServerHost';
import { readProcessOwnershipBootTimeMs } from '@/daemon/processes/roots/listHappierProcessRoots';
import { projectMachineProcesses } from '@/daemon/processes/view/projectMachineProcesses';
import { createProcessActionOwnerAdapters } from '@/daemon/processes/actions/processActionOwnerAdapters';
import { createAttachedManagedRunFixture } from './startDaemonSessionControlRuntime.accountManagedRun.testkit';

it('discovers and controls the live language-server root through daemon Processes composition', async () => {
    const startup = await createAttachedManagedRunFixture();
    let handle: PluginProtocolClientHandle<'jsonRpc'> | undefined;
    try {
        const rootPath = startup.directory;
        const log = join(rootPath, 'lsp-messages.jsonl');
        await writeFile(log, '');
        const registry = createResolvedContributionRegistry({ languageServers: [{
            provenance: 'external', source: { kind: 'path' }, pluginId: 'fixture.language',
            identity: { pluginId: 'fixture.language', localId: 'language' }, manifestPath: join(rootPath, 'plugin.json'),
            definition: { id: 'language', title: 'Fixture language', languageIds: { typescript: 'typescript' },
                executable: { kind: 'systemTool', id: 'native' }, args: [] },
        }] });
        configureLanguageServerHost({ readCurrentContributionRegistry: () => registry, async openProtocol(input) {
            // Only the executable/OS boundary is supplied; native custody and Processes stay real.
            const exec = createStablePluginExecService({ allowedExecutables: [input.definition.executable],
                signal: input.signal, processOwner: input.processOwner, isOccurrenceCurrent: () => !input.signal.aborted,
                resolveExecutable: async () => ({ command: process.execPath, args: [resolve('src/lsp/__fixtures__/languageServer.cjs'), log] }),
                resolvePath: async () => rootPath });
            handle = await exec.clients.spawn({ kind: 'jsonRpc', framing: 'contentLength', cancellationMethod: '$/cancelRequest',
                maxFrameBytes: DEFAULT_JSON_RPC_MAX_FRAME_BYTES, launch: { executable: input.definition.executable, cwd: rootPath } });
            return handle;
        } });
        const host = getLanguageServerHost();
        expect(await host.sync({ rootPath, op: { op: 'open', path: 'a.ts', languageId: 'typescript', text: 'shared', version: 1, unsaved: false } }))
            .toMatchObject({ status: 'ok', servers: [{ state: 'ready' }] });
        if (!handle) throw new Error('Language server did not start');
        const pid = readSupervisedPluginProcessIdForHost(handle.process);
        const read = await startup.runtime.processOwnershipRuntime.readOwners({ freshness: 'fresh', requesterAttribution: 'retained' });
        expect(read.status).toBe('ok');
        if (read.status !== 'ok') throw new Error('Native process ownership unavailable');
        const root = read.roots.find(candidate => candidate.pid === pid);
        expect(root).toMatchObject({ owner: { kind: 'service', serviceId: expect.stringMatching(/^lsp:/) }, live: true });
        const answer = projectMachineProcesses(read, { machineId: 'machine', scope: 'happier', view: 'tree' },
            { accountId: 'account', custodianAccountId: 'account' }, {
                platform: process.platform as 'linux' | 'darwin' | 'win32', selfPid: process.pid, allProcessesVisible: true,
                bootTimeMs: await readProcessOwnershipBootTimeMs(), confirmed: [], requesterForOwner: () => ({ accountId: 'account' }),
            });
        expect(answer.owners.flatMap(owner => owner.members).find(row => row.pid === pid)).toMatchObject({ role: 'language_server' });
        if (!root) throw new Error('Missing language-server root');
        await createProcessActionOwnerAdapters({}).stopOwner(root, { verifyCurrent: async () => true });
        await handle.wait();
        expect(await host.query({ rootPath, path: 'a.ts', kind: 'hover', position: { line: 0, character: 0 } }))
            .toMatchObject({ status: 'error', errorCode: 'session_unavailable' });
    } finally { await disposeLanguageServerHost(); await startup.cleanup(); }
});
