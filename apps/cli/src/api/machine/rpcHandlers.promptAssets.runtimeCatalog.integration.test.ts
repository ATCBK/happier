import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createPromptAssetAdapterRegistry } from '@/prompts/assets/createPromptAssetAdapterRegistry';

import { registerMachineRpcHandlers } from './rpcHandlers';

type Handler = (data: unknown, context?: { signal?: AbortSignal }) => Promise<any>;

function createRpcHandlerManager(): { handlers: Map<string, Handler>; registerHandler: (method: string, handler: Handler) => void } {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    registerHandler(method, handler) {
      handlers.set(method, handler);
    },
  };
}

describe('rpcHandlers (prompt assets)', () => {
  it('registers the surviving prompt asset handlers and omits legacy inline read/write handlers', () => {
    const mgr = createRpcHandlerManager();

    registerMachineRpcHandlers({
      rpcHandlerManager: mgr as any,
      handlers: {
        spawnSession: async () => ({ type: 'error', errorCode: 'unknown', errorMessage: 'not implemented' }) as any,
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    expect(mgr.handlers.has(RPC_METHODS.DAEMON_PROMPT_ASSETS_LIST_TYPES)).toBe(true);
    expect(mgr.handlers.has(RPC_METHODS.SKILLS_FOUND_LIST)).toBe(true);
    expect(mgr.handlers.has('daemon.promptAssets.discover')).toBe(false);
    expect(mgr.handlers.has(RPC_METHODS.DAEMON_PROMPT_ASSETS_DELETE)).toBe(true);
    expect(mgr.handlers.has('daemon.promptAssets.read')).toBe(false);
    expect(mgr.handlers.has('daemon.promptAssets.write')).toBe(false);
  });

  it('deletes user agent skills using the current digest', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-prompt-assets-workspace-'));
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-prompt-assets-home-'));
    try {
      const registry = createPromptAssetAdapterRegistry({
        homedir: () => homeDir,
      });
      const adapter = registry.get('agents.skill');
      if (!adapter) {
        throw new Error('expected agents.skill adapter');
      }

      const committed = await adapter.writeBundle({
        assetTypeId: 'agents.skill',
        scope: 'user',
        directory: workspace,
        targetName: 'writer',
        title: 'Writer',
        bundleSchemaId: 'skills.skill_md_v1',
        bundleBody: {
          v: 1,
          entries: [
            { path: 'SKILL.md', contentBase64: Buffer.from('# Writer skill\n', 'utf8').toString('base64'), contentKind: 'utf8' },
            { path: 'notes.txt', contentBase64: Buffer.from('remember me\n', 'utf8').toString('base64'), contentKind: 'utf8' },
          ],
          createdAtMs: 1,
          updatedAtMs: 2,
        },
        previewOnly: false,
        expectedDigest: null,
      });
      expect(committed.ok).toBe(true);
      if (!committed.ok) {
        throw new Error(`expected initial write to succeed: ${committed.error}`);
      }

      const mgr = createRpcHandlerManager();
      registerMachineRpcHandlers({
        rpcHandlerManager: mgr as any,
        handlers: {
          spawnSession: async () => ({ type: 'error', errorCode: 'unknown', errorMessage: 'not implemented' }) as any,
          stopSession: async () => true,
          requestShutdown: () => {},
        },
        deps: {
          promptAssetsHomedir: () => homeDir,
        },
      });

      const remove = mgr.handlers.get(RPC_METHODS.DAEMON_PROMPT_ASSETS_DELETE);
      if (!remove) {
        throw new Error('expected prompt asset delete handler');
      }

      await expect(remove({
        assetTypeId: 'agents.skill',
        scope: 'user',
        directory: workspace,
        externalRef: { skillName: 'writer' },
        previewOnly: false,
        expectedDigest: committed.digest,
      })).resolves.toMatchObject({ ok: true });

      expect(() => readFileSync(join(homeDir, '.agents', 'skills', 'writer', 'SKILL.md'), 'utf8')).toThrow();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('deletes project Claude commands using the current digest', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-prompt-assets-workspace-'));
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-prompt-assets-home-'));
    try {
      const registry = createPromptAssetAdapterRegistry({
        homedir: () => homeDir,
      });
      const adapter = registry.get('claude.command');
      if (!adapter) {
        throw new Error('expected claude.command adapter');
      }

      const committed = await adapter.writeDoc({
        assetTypeId: 'claude.command',
        scope: 'project',
        directory: workspace,
        externalRef: null,
        targetPath: 'review/code.md',
        title: 'review/code',
        markdown: '# Review code\n\nUse $ARGUMENTS\n',
        previewOnly: false,
        expectedDigest: null,
      });
      expect(committed.ok).toBe(true);
      if (!committed.ok) {
        throw new Error(`expected initial write to succeed: ${committed.error}`);
      }

      const mgr = createRpcHandlerManager();
      registerMachineRpcHandlers({
        rpcHandlerManager: mgr as any,
        handlers: {
          spawnSession: async () => ({ type: 'error', errorCode: 'unknown', errorMessage: 'not implemented' }) as any,
          stopSession: async () => true,
          requestShutdown: () => {},
        },
        deps: {
          promptAssetsHomedir: () => homeDir,
        },
      });

      const remove = mgr.handlers.get(RPC_METHODS.DAEMON_PROMPT_ASSETS_DELETE);
      if (!remove) {
        throw new Error('expected prompt asset delete handler');
      }

      await expect(remove({
        assetTypeId: 'claude.command',
        scope: 'project',
        directory: workspace,
        externalRef: { relativePath: 'review/code.md' },
        previewOnly: false,
        expectedDigest: committed.digest,
      })).resolves.toMatchObject({ ok: true });

      expect(() => readFileSync(join(workspace, '.claude', 'commands', 'review', 'code.md'), 'utf8')).toThrow();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
