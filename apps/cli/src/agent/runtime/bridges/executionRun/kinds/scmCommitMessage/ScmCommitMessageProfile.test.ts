import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { AgentExecutionRunOpenRequest, AgentExecutionRunRuntimeContextV1, AgentRuntime } from '@happier-dev/plugin-sdk/agents/runtime';
import { ExecutionRunScmCommitMessageResultV1Schema } from '@happier-dev/protocol/execution/runs/startRequest';
import { isScmPatchBoundToPath } from '@happier-dev/protocol/scm';
import { accountSettingsParse } from '@happier-dev/protocol';
import { createLocalScmRepositoryFixture, runScmExecutable } from '@/testkit/scm/scmBackendContractFixtures';
import type { ExecutionRunController } from '@/agent/executionRuns/controllers/types';
import { VoiceAgentManager } from '@/agent/voice/agent/VoiceAgentManager';
import type { ExecutionRunManagerStartParams, ExecutionRunState } from '../../executionRunTypes';
import type { FinishExecutionRun } from '../../executionRunFinishRun';
import { startExecutionRun } from '../../startExecutionRun';
import { executeBoundedBackendRun } from '../../bounded/loop';
import { createNativeAgentExecutionRunContextLeaseFactory, createNativeAgentExecutionRunHostRuntime } from '../../nativeAgentExecutionRun';
import { ScmCommitMessageProfile } from './ScmCommitMessageProfile';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';

beforeAll(async () => {
  const lease = await pluginReloadController.acquireRuntimeRegistry({
    resolveRuntimeRegistry: () => resolveExecutablePluginRuntimeRegistry({ pluginIds: ['happier.scm.backend.git'] }),
  });
  await lease.release();
});
afterAll(async () => { await pluginReloadController.shutdown(); });

async function verifyNativeCommitMessageRun({ permissionMode, include, literalPaths = false }: {
  permissionMode: string;
  include?: string[];
  literalPaths?: boolean;
}) {
  const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'scm-commit-native-' });
  const runs = new Map<string, ExecutionRunState>();
  const controllers = new Map<string, ExecutionRunController>();
  const opens: Array<{ request: AgentExecutionRunOpenRequest; context: AgentExecutionRunRuntimeContextV1 }> = [];
  const result = { title: 'fix: update tracked content', body: 'Explain the changed line.', message: 'fix: update tracked content\n\nExplain the changed line.', confidence: 0.9 };
  // The typed Agent SDK surface is the provider/model boundary; all host preparation,
  // native context composition, admission and completion remain real.
  const runtime: AgentRuntime = { executionRuns: { async open(request, context) {
    if (!('executionRun' in context)) throw new Error('Expected a detached execution context');
    opens.push({ request, context });
    expect(await context.services.interactions.requestApproval({
      kind: 'approval', title: 'Read a repository file', subject: { kind: 'tool', name: 'Read', input: { file_path: join(fixture.rootPath, fixture.trackedPath) } },
    })).toMatchObject({ kind: 'approval', status: 'declined' });
    return {
      async send() { return { status: 'admitted' as const }; },
      async stop() { return { status: 'requested' as const }; },
      watch(listener) {
        listener({ kind: 'output-delta', runId: request.runId, sequence: 1, emittedAtMs: Date.now(), channel: 'assistant', text: JSON.stringify(result) });
        listener({ kind: 'run-complete', runId: request.runId, sequence: 2, emittedAtMs: Date.now() });
        return { dispose() {} };
      },
      async dispose() {},
    };
  } } };
  const voiceAgentManager = new VoiceAgentManager({ createRuntime: () => { throw new Error('Commit-message Runs must not create a Voice runtime'); } });
  let completed!: (value: unknown) => void;
  const completion = new Promise<unknown>(resolve => { completed = resolve; });
  const finishRun: FinishExecutionRun = async (runId, next, toolResult) => {
    const current = runs.get(runId);
    if (!current) throw new Error('Run state missing');
    runs.set(runId, { ...current, ...next });
    completed(toolResult.output);
  };
  const sendAcp: Parameters<typeof startExecutionRun>[0]['sendAcp'] = async () => { throw new Error('Detached Runs must not publish to a Session transcript'); };
  try {
    if (literalPaths) {
      for (const path of ['file', 'file ', ' ']) await writeFile(join(fixture.rootPath, path), 'base\n');
      runScmExecutable(fixture.rootPath, 'git', ['add', '--', 'file', 'file ', ' ']);
      runScmExecutable(fixture.rootPath, 'git', ['commit', '-m', 'literal filenames']);
      await writeFile(join(fixture.rootPath, 'file'), 'unselected-plain-file-evidence\n');
      await writeFile(join(fixture.rootPath, 'file '), 'selected-trailing-space-evidence\n');
      await writeFile(join(fixture.rootPath, ' '), 'selected-whitespace-only-evidence\n');
    }
    await writeFile(join(fixture.rootPath, fixture.trackedPath), 'native-commit-evidence\n');
    const request = {
      kind: 'scm_commit_message.v1' as const,
      intent: 'scm_commit_message' as const, backendTarget: { kind: 'builtInAgent' as const, agentId: 'claude' },
      instructions: '', intentInput: { instructions: 'Keep the title concise', ...(include ? { scope: { kind: 'paths' as const, include } } : {}) }, permissionMode,
      retentionPolicy: 'ephemeral' as const, runClass: 'bounded' as const, ioMode: 'request_response' as const,
    };
    const prepared = await ScmCommitMessageProfile.prepareStartParams!({ sessionId: null, request, cwd: fixture.rootPath });
    expect(prepared).toMatchObject({ permissionMode: 'no_tools' });
    const params: ExecutionRunManagerStartParams = { ...request, ...prepared, sessionId: null, cwd: fixture.rootPath };
    const started = await startExecutionRun({
      params, parentProvider: 'claude', sendAcp, streamedTranscriptSession: null, getNowMs: Date.now,
      budgetRegistry: null, runs, controllers, voiceAgentManager, finishRun,
      // Marker publication is an injected OS persistence boundary; use the real writer.
      enqueueMarkerWrite: async (_id, write) => { await write(); }, writeActivityMarker: async () => {},
      send: async () => { throw new Error('A bounded Run must use its native input path'); },
      executeBoundedRun: args => executeBoundedBackendRun({ ...args, runs, controllers, sendAcp,
        parentProvider: 'claude', getNowMs: Date.now, boundedTimeoutMs: null, finishRun }),
      createRuntime: options => {
        if (!options.runId || !options.controllerOccurrenceId || !options.callId || !options.sidechainId || !options.start) throw new Error('Missing native Run identity');
        const lease = { pluginId: 'acme.commit', pluginVersion: '1.0.0', agentId: 'acme.commit/agents/default',
          localAgentId: 'default', occurrenceId: options.controllerOccurrenceId, isCurrent: () => true };
        return createNativeAgentExecutionRunHostRuntime({ runtime, lease, supportsResume: false,
          options: { ...options, cwd: fixture.rootPath, scope: 'detached',
            accountSettings: options.accountSettings == null ? options.accountSettings : accountSettingsParse(options.accountSettings) },
          createExecutionRunContext: createNativeAgentExecutionRunContextLeaseFactory({ lease,
            runId: options.runId, controllerOccurrenceId: options.controllerOccurrenceId, callId: options.callId,
            sidechainId: options.sidechainId, runtimeRegistry: null, directory: fixture.rootPath,
            machineId: 'native-commit-machine', accountSettings: null, permissionMode: options.permissionMode, start: options.start }),
        });
      },
    });
    expect(ExecutionRunScmCommitMessageResultV1Schema.parse(await completion)).toEqual(result);
    expect(runs.get(started.runId)).toMatchObject({ sessionId: null, status: 'succeeded', permissionMode: 'no_tools' });
    expect(opens).toHaveLength(1);
    expect(opens[0]?.request).toMatchObject({ kind: 'create', cwd: fixture.rootPath, profile: { pluginId: 'acme.commit', localId: 'scm-commit-message' } });
    if (opens[0]?.request.kind !== 'create') throw new Error('Expected native create');
    const prompt = opens[0].request.input.text;
    if (!literalPaths) {
      expect(prompt).toContain('native-commit-evidence');
      expect(prompt).toContain(fixture.trackedPath);
    } else if (!include) {
      expect(prompt).toContain('native-commit-evidence');
      expect(prompt).toContain('selected-trailing-space-evidence');
      expect(prompt).toContain('selected-whitespace-only-evidence');
      expect(prompt).toContain('-   (');
    } else {
      expect(prompt).toContain(include[0] === 'file ' ? 'selected-trailing-space-evidence' : 'selected-whitespace-only-evidence');
      expect(prompt).not.toContain('unselected-plain-file-evidence');
      expect(prompt).not.toContain('native-commit-evidence');
    }
    expect(opens[0].request.input.text).toContain('Keep the title concise');
    expect(opens[0].context).toMatchObject({ scope: { kind: 'execution_run', executionRunId: started.runId } });
    expect(opens[0].context).not.toHaveProperty('session');
    for (const path of literalPaths ? ['file', 'file ', ' '] : [fixture.trackedPath]) {
      const patch = runScmExecutable(fixture.rootPath, 'git', ['diff', '--', path]);
      expect(isScmPatchBoundToPath(path, patch), patch).toBe(true);
      if (literalPaths && path !== 'file') expect(isScmPatchBoundToPath('file', patch), patch).toBe(false);
    }
  } finally {
    await Promise.all([...controllers.values()].filter(controller => controller.kind === 'backend').map(controller => controller.backend.dispose()));
    await voiceAgentManager.dispose();
    await rm(fixture.rootPath, { recursive: true, force: true });
  }
}

it.each(['no_tools', 'yolo'])('prepares repository evidence and completes a detached no-tools native Run from %s input',
  permissionMode => verifyNativeCommitMessageRun({ permissionMode }));

it.skipIf(process.platform === 'win32').each([
  { permissionMode: 'no_tools', include: undefined },
  { permissionMode: 'yolo', include: ['file '] },
  { permissionMode: 'no_tools', include: [' '] },
])('prepares literal repository evidence for a detached native Run: %j',
  params => verifyNativeCommitMessageRun({ ...params, literalPaths: true }));
