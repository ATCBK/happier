import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
const { fixtureHome } = vi.hoisted(() => ({ fixtureHome: vi.fn<() => string | undefined>() }));
vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => fixtureHome() ?? actual.homedir() };
});

import type { TransferRelayV2SendEnvelope } from '@happier-dev/protocol';
import { createTransferRecipientKeyPair, decryptEncryptedTransferChunkEnvelope } from '@happier-dev/transfers/node';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { registerMachineRpcHandlers } from './rpcHandlers';
import { accountSettingsParse,RegistrySkillFilesPayloadV1Schema } from '@happier-dev/protocol';
import { FoundSkillBundleV1Schema } from '@happier-dev/protocol/prompts/library/skills/foundSkillTransferV1';
import { clearActiveAccountSettingsSnapshot, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

type Handler = (data: unknown) => Promise<any>;

function createRpcHandlerManager(): { handlers: Map<string, Handler>; registerHandler: (method: string, handler: Handler) => void } {
    const handlers = new Map<string, Handler>();
    return {
        handlers,
        registerHandler(method, handler) {
            handlers.set(method, handler);
        },
    };
}

function git(cwd: string, args: readonly string[]): string {
    return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'Happier Bot',
            GIT_AUTHOR_EMAIL: 'bot@example.com',
            GIT_COMMITTER_NAME: 'Happier Bot',
            GIT_COMMITTER_EMAIL: 'bot@example.com',
        },
    }).trim();
}

function createTransferRelayChannelHarness(machineId: string) {
    const listeners = new Set<(payload: TransferRelayV2SendEnvelope) => void>();
    const sent: TransferRelayV2SendEnvelope[] = [];

    return {
        sent,
        channel: {
            machineId,
            onEnvelope(listener: (payload: TransferRelayV2SendEnvelope) => void) {
                listeners.add(listener);
                return () => {
                    listeners.delete(listener);
                };
            },
            sendEnvelope(payload: TransferRelayV2SendEnvelope) {
                sent.push(payload);
            },
        },
        emitFromUser(payload: TransferRelayV2SendEnvelope) {
            for (const listener of listeners) {
                listener(payload);
            }
        },
    };
}

async function waitForSentCount(sent: readonly TransferRelayV2SendEnvelope[], count: number): Promise<void> {
    const startedAt = Date.now();
    while (sent.length < count) {
        if (Date.now() - startedAt > 2_000) {
            throw new Error(`Timed out waiting for ${count} relay envelopes; saw ${sent.length}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

describe('rpcHandlers relay-v2 download wiring', () => {
    it('streams prompt asset downloads over the live relay-v2 channel', async () => {
        const homeDir = mkdtempSync(join(tmpdir(), 'happier-prompt-relay-home-'));
        fixtureHome.mockReturnValue(homeDir);

        try {
            mkdirSync(join(homeDir, '.agents', 'skills', 'reviewer'), { recursive: true });
            writeFileSync(join(homeDir, '.agents', 'skills', 'reviewer', 'SKILL.md'), '---\nname: reviewer\n---\n# Reviewer\n', 'utf8');
            writeFileSync(join(homeDir, '.agents', 'skills', 'reviewer', 'notes.txt'), 'Remember this\n', 'utf8');

            const mgr = createRpcHandlerManager();
            const relay = createTransferRelayChannelHarness('machine-1');
            registerMachineRpcHandlers({
                rpcHandlerManager: mgr as any,
                handlers: {
                    spawnSession: async () => ({ type: 'error', errorCode: 'unknown', errorMessage: 'not implemented' }) as any,
                    stopSession: async () => true,
                    requestShutdown: () => {},
                    transferRelayV2Channel: relay.channel,
                },
                deps: {
                },
            });

            const init = mgr.handlers.get(RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_INIT);
            if (!init) throw new Error('expected prompt asset download init handler');

            const recipientKeyPair = createTransferRecipientKeyPair();
            const initResponse = await init({
                path: join(homeDir, '.agents', 'skills', 'reviewer'),
                recipientPublicKeyBase64: recipientKeyPair.recipientPublicKeyBase64,
            });
            expect(initResponse).toMatchObject({ success: true, downloadId: expect.any(String) });

            relay.emitFromUser({
                scopeUserId: 'user-1',
                sender: {
                    kind: 'user',
                    socketId: 'socket-1',
                },
                recipient: {
                    kind: 'machine',
                    machineId: 'machine-1',
                },
                envelope: {
                    transferId: initResponse.downloadId,
                    kind: 'open',
                    recipientPublicKeyBase64: recipientKeyPair.recipientPublicKeyBase64,
                },
            });

            await waitForSentCount(relay.sent, 1);
            expect(relay.sent[0]).toMatchObject({
                scopeUserId: 'user-1',
                sender: {
                    kind: 'machine',
                    machineId: 'machine-1',
                },
                recipient: {
                    kind: 'user',
                },
                envelope: {
                    transferId: initResponse.downloadId,
                    kind: 'chunk',
                    sequence: 0,
                },
            });

            const chunkEnvelope = relay.sent[0]?.envelope;
            if (!chunkEnvelope || chunkEnvelope.kind !== 'chunk' || !chunkEnvelope.encryptedDataKeyEnvelopeBase64) {
                throw new Error('expected encrypted chunk envelope');
            }
            const payload = JSON.parse(decryptEncryptedTransferChunkEnvelope({
                transferId: initResponse.downloadId,
                sequence: chunkEnvelope.sequence,
                payloadBase64: chunkEnvelope.payloadBase64,
                encryptedDataKeyEnvelopeBase64: chunkEnvelope.encryptedDataKeyEnvelopeBase64,
                recipientSecretKeySeed: recipientKeyPair.recipientSecretKeySeed,
            }).toString('utf8'));
            expect(FoundSkillBundleV1Schema.parse(payload)).toMatchObject({
                name: 'reviewer',
                path: join(homeDir, '.agents', 'skills', 'reviewer'),
                pluginOwned: null,
                files: [
                    { path: 'SKILL.md', contentKind: 'utf8', contentBase64: Buffer.from('---\nname: reviewer\n---\n# Reviewer\n').toString('base64') },
                    { path: 'notes.txt', contentKind: 'utf8', contentBase64: Buffer.from('Remember this\n').toString('base64') },
                ],
            });

            relay.emitFromUser({
                scopeUserId: 'user-1',
                sender: {
                    kind: 'user',
                    socketId: 'socket-1',
                },
                recipient: {
                    kind: 'machine',
                    machineId: 'machine-1',
                },
                envelope: {
                    transferId: initResponse.downloadId,
                    kind: 'ack',
                    nextSequence: 1,
                },
            });

            await waitForSentCount(relay.sent, 2);
            expect(relay.sent[1]).toMatchObject({
                scopeUserId: 'user-1',
                sender: {
                    kind: 'machine',
                    machineId: 'machine-1',
                },
                recipient: {
                    kind: 'user',
                },
                envelope: {
                    transferId: initResponse.downloadId,
                    kind: 'finish',
                    manifestHash: expect.stringMatching(/^sha256:/),
                },
            });
        } finally {
            rmSync(homeDir, { recursive: true, force: true });
        }
    });

    it('replaces the relay-v2 download responder when machine RPC handlers are registered again', async () => {
        const homeDir = mkdtempSync(join(tmpdir(), 'happier-prompt-relay-home-reconnect-'));
        fixtureHome.mockReturnValue(homeDir);

        try {
            mkdirSync(join(homeDir, '.agents', 'skills', 'reviewer'), { recursive: true });
            writeFileSync(join(homeDir, '.agents', 'skills', 'reviewer', 'SKILL.md'), '---\nname: reviewer\n---\n# Reviewer\n', 'utf8');
            writeFileSync(join(homeDir, '.agents', 'skills', 'reviewer', 'notes.txt'), 'Remember this\n', 'utf8');

            const mgr = createRpcHandlerManager();
            const relay = createTransferRelayChannelHarness('machine-1');

            registerMachineRpcHandlers({
                rpcHandlerManager: mgr as any,
                handlers: {
                    spawnSession: async () => ({ type: 'error', errorCode: 'unknown', errorMessage: 'not implemented' }) as any,
                    stopSession: async () => true,
                    requestShutdown: () => {},
                    transferRelayV2Channel: relay.channel,
                },
                deps: {
                },
            });

            registerMachineRpcHandlers({
                rpcHandlerManager: mgr as any,
                handlers: {
                    spawnSession: async () => ({ type: 'error', errorCode: 'unknown', errorMessage: 'not implemented' }) as any,
                    stopSession: async () => true,
                    requestShutdown: () => {},
                    transferRelayV2Channel: relay.channel,
                },
                deps: {
                },
            });

            const init = mgr.handlers.get(RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_INIT);
            if (!init) throw new Error('expected prompt asset download init handler');

            const recipientKeyPair = createTransferRecipientKeyPair();
            const initResponse = await init({
                path: join(homeDir, '.agents', 'skills', 'reviewer'),
                recipientPublicKeyBase64: recipientKeyPair.recipientPublicKeyBase64,
            });
            expect(initResponse).toMatchObject({ success: true, downloadId: expect.any(String) });

            relay.emitFromUser({
                scopeUserId: 'user-1',
                sender: {
                    kind: 'user',
                    socketId: 'socket-1',
                },
                recipient: {
                    kind: 'machine',
                    machineId: 'machine-1',
                },
                envelope: {
                    transferId: initResponse.downloadId,
                    kind: 'open',
                    recipientPublicKeyBase64: recipientKeyPair.recipientPublicKeyBase64,
                },
            });

            await waitForSentCount(relay.sent, 1);
            await vi.waitFor(() => {
                expect(relay.sent.some((payload) => (
                    payload.envelope.transferId === initResponse.downloadId
                    && payload.envelope.kind === 'chunk'
                ))).toBe(true);
            });
            expect(relay.sent.some((payload) => (
                payload.envelope.transferId === initResponse.downloadId
                && payload.envelope.kind === 'abort'
            ))).toBe(false);
        } finally {
            rmSync(homeDir, { recursive: true, force: true });
        }
    });

    it('streams prompt registry downloads over the live relay-v2 channel', async () => {
        const repo = mkdtempSync(join(tmpdir(), 'happier-prompt-registry-relay-repo-'));
        const happierHomeDir = mkdtempSync(join(tmpdir(), 'happier-prompt-registry-relay-home-'));

        try {
            mkdirSync(join(repo, 'reviewer'), { recursive: true });
            writeFileSync(join(repo, 'reviewer', 'SKILL.md'), '---\nname: reviewer\n---\n# Reviewer\n', 'utf8');
            writeFileSync(join(repo, 'reviewer', 'notes.txt'), 'remember me\n', 'utf8');
            git(repo, ['init', '-b', 'main']);
            git(repo, ['add', '.']);
            git(repo, ['commit', '-m', 'init']);

            const mgr = createRpcHandlerManager();
            const relay = createTransferRelayChannelHarness('machine-1');
            registerMachineRpcHandlers({
                rpcHandlerManager: mgr as any,
                handlers: {
                    spawnSession: async () => ({ type: 'error', errorCode: 'unknown', errorMessage: 'not implemented' }) as any,
                    stopSession: async () => true,
                    requestShutdown: () => {},
                    transferRelayV2Channel: relay.channel,
                },
                deps: {
                },
            });

            const scanSource = mgr.handlers.get(RPC_METHODS.DAEMON_REGISTRIES_FETCH);
            const downloadInit = mgr.handlers.get(RPC_METHODS.DAEMON_REGISTRIES_DOWNLOAD_INIT);
            if (!scanSource || !downloadInit) {
                throw new Error('expected prompt registry handlers');
            }

            setActiveAccountSettingsSnapshot({source:'network',settings:accountSettingsParse({}),settingsVersion:1,loadedAtMs:1,settingsSecretsReadKeys:[],
              promptLibraryCatalog:{status:'ready',rows:[{revision:1,record:{key:'registry-sources',value:{v:2,disabledSourceIds:[],sources:[
                {id:'local-skills',title:'Local skills',format:'git',kinds:['skill'],url:repo,enabled:true,addedAt:0},
              ]}}}],diagnostics:[],tombstones:[]}});

            const scan = await scanSource({
                op: 'list',kind:'skill',sourceId: 'local-skills',
            });
            expect(scan).toMatchObject({ op:'list',page:{status:{state:'ok'}} });

            const recipientKeyPair = createTransferRecipientKeyPair();
            const initResponse = await downloadInit({
                kind:'skill',sourceId: 'local-skills',
                itemId: scan.page.items[0]?.itemId,
                version: scan.page.items[0]?.version,
                recipientPublicKeyBase64: recipientKeyPair.recipientPublicKeyBase64,
            });
            expect(initResponse).toMatchObject({ success: true, downloadId: expect.any(String) });

            relay.emitFromUser({
                scopeUserId: 'user-1',
                sender: {
                    kind: 'user',
                    socketId: 'socket-1',
                },
                recipient: {
                    kind: 'machine',
                    machineId: 'machine-1',
                },
                envelope: {
                    transferId: initResponse.downloadId,
                    kind: 'open',
                    recipientPublicKeyBase64: recipientKeyPair.recipientPublicKeyBase64,
                },
            });

            await waitForSentCount(relay.sent, 1);
            const chunkEnvelope = relay.sent[0]?.envelope;
            if (!chunkEnvelope || chunkEnvelope.kind !== 'chunk' || !chunkEnvelope.encryptedDataKeyEnvelopeBase64) {
                throw new Error('expected encrypted chunk envelope');
            }
            const payload = JSON.parse(decryptEncryptedTransferChunkEnvelope({
                transferId: initResponse.downloadId,
                sequence: chunkEnvelope.sequence,
                payloadBase64: chunkEnvelope.payloadBase64,
                encryptedDataKeyEnvelopeBase64: chunkEnvelope.encryptedDataKeyEnvelopeBase64,
                recipientSecretKeySeed: recipientKeyPair.recipientSecretKeySeed,
            }).toString('utf8'));
            expect(RegistrySkillFilesPayloadV1Schema.parse(payload)).toMatchObject([
                { path: 'SKILL.md', contentBase64: Buffer.from('---\nname: reviewer\n---\n# Reviewer\n').toString('base64') },
                { path: 'notes.txt', contentBase64: Buffer.from('remember me\n').toString('base64') },
            ]);

            relay.emitFromUser({
                scopeUserId: 'user-1',
                sender: {
                    kind: 'user',
                    socketId: 'socket-1',
                },
                recipient: {
                    kind: 'machine',
                    machineId: 'machine-1',
                },
                envelope: {
                    transferId: initResponse.downloadId,
                    kind: 'ack',
                    nextSequence: 1,
                },
            });

            await waitForSentCount(relay.sent, 2);
            expect(relay.sent[1]).toMatchObject({
                envelope: {
                    transferId: initResponse.downloadId,
                    kind: 'finish',
                    manifestHash: expect.stringMatching(/^sha256:/),
                },
            });
        } finally {
            clearActiveAccountSettingsSnapshot();
            rmSync(repo, { recursive: true, force: true });
            rmSync(happierHomeDir, { recursive: true, force: true });
        }
    });
});
