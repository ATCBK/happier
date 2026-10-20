import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ExecService } from '@happier-dev/plugin-sdk/exec';

import { createCodexNativeAppServerClient } from './client.js';
import { createCodexAppServerRuntime, startCodexAppServerRuntime, waitForCodexAppServerRuntimeTurnCompletion } from './runtime.js';

// Opt-in real-provider boundary: no Account credentials or external model calls.
// Use the exact supported binary via HAPPIER_CODEX_NATIVE_TEST_BIN.
const nativeBinary = process.env.HAPPIER_CODEX_NATIVE_TEST_BIN;
describe.skipIf(!nativeBinary || process.platform === 'win32')('native Codex rollout persistence', () => {
  it('resumes captured conversation after replacing the native process and private SQLite home', async () => {
    const root = await mkdtemp('/tmp/r77-');
    const home = join(root, 'home');
    await mkdir(home);
    const message = { id: 'msg-r77', type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'Persisted answer.', annotations: [] }] };
    const requestBodies: string[] = [];
    const model = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      request.on('end', () => { requestBodies.push(body); });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const result = { id: 'resp-r77', object: 'response', status: 'completed', output: [message],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
      for (const event of [
        { type: 'response.created', response: { ...result, status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item: message },
        { type: 'response.output_item.done', output_index: 0, item: message },
        { type: 'response.completed', response: result },
      ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      response.end();
    });
    model.listen(0, '127.0.0.1');
    await once(model, 'listening');
    const address = model.address();
    if (!address || typeof address === 'string') throw new Error('Missing local model address');
    await writeFile(join(home, 'config.toml'), [
      'model_provider = "r77"', 'model = "r77-model"',
      '[model_providers.r77]', 'name = "Native persistence fixture"',
      `base_url = "http://127.0.0.1:${address.port}"`,
      'wire_api = "responses"', 'requires_openai_auth = false',
    ].join('\n'));
    // Tool resolution is the SDK/OS boundary; runtime, IPC, native history and
    // recovery are real. No internal lifecycle or persistence helper is mocked.
    const exec = { systemTools: { resolve: async () => ({
      executable: { kind: 'systemTool', id: 'codex-cli' }, executablePath: nativeBinary,
    }) } } as unknown as ExecService;
    const opened: Array<() => Promise<void>> = [];
    const launch = async (generation: number) => {
      const sqliteHome = join(root, `sqlite-${generation}`);
      await mkdir(sqliteHome);
      const socketPath = join(root, `native-${generation}.sock`);
      const env = { PATH: process.env.PATH ?? '', HOME: home, CODEX_HOME: home, CODEX_SQLITE_HOME: sqliteHome };
      const child = spawn(nativeBinary!, ['app-server', '--listen', `unix://${socketPath}`], {
        cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (value: Buffer) => { stderr += value.toString(); });
      const exited = once(child, 'exit');
      const runtime = createCodexAppServerRuntime({
        executionRunId: 'review-persistence-fixture', directory: root, initialModelId: 'r77-model',
        initialPermissionMode: 'read-only', processEnv: env,
        host: { baseProcessEnv: env, logger: { debug() {}, warn() {} }, createClient: async () => {
          await expect.poll(async () => {
            if (child.exitCode !== null) throw new Error(`Native startup failed: ${stderr}`);
            return await stat(socketPath).then(() => true, () => false);
          }).toBe(true);
          return await createCodexNativeAppServerClient({ exec, processEnv: env,
            transport: { kind: 'unixWebSocket', socketPath, realtimeConversationAdvertised: false } });
        } },
      });
      let closed = false;
      const close = async () => {
        if (closed) return;
        closed = true;
        // Kill before disconnecting the client: socket teardown must not
        // accidentally provide a clean native flush that real retirement lost.
        child.kill('SIGKILL');
        await exited;
        await runtime.dispose();
      };
      opened.push(close);
      return { runtime, close };
    };
    try {
      const first = await launch(1);
      const threadId = await startCodexAppServerRuntime(first.runtime);
      await first.runtime.prepareProviderCliAttach();
      await first.runtime.send({ text: 'Remember this native persistence fixture.' });
      await waitForCodexAppServerRuntimeTurnCompletion(first.runtime);
      await first.runtime.send({ text: 'Narrate the same captured comparison.' });
      await waitForCodexAppServerRuntimeTurnCompletion(first.runtime);
      await first.close();
      // Only the existing durable rollout travels to a fresh native index.
      // This isolates the rollout-only recovery contract from Account materialization.
      const rollouts: string[] = [];
      const walk = async (directory: string): Promise<void> => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name);
          if (entry.isDirectory()) await walk(path);
          else if (entry.name.endsWith(`${threadId}.jsonl`)) rollouts.push(path);
        }
      };
      await walk(join(home, 'sessions'));
      expect(rollouts).toHaveLength(1);
      const records = (await readFile(rollouts[0], 'utf8')).trim().split('\n')
        .map(line => JSON.parse(line) as { type: string });
      expect(records.some(record => record.type === 'response_item')).toBe(true);
      const second = await launch(2);
      await expect(startCodexAppServerRuntime(second.runtime, {
        resumeId: threadId, strictNativeResumeIdentity: true, importHistory: true,
      })).resolves.toBe(threadId);
      await second.runtime.send({ text: 'Continue the persisted conversation.' });
      await waitForCodexAppServerRuntimeTurnCompletion(second.runtime);
      expect(requestBodies.at(-1)).toContain('Remember this native persistence fixture.');
      expect(requestBodies.at(-1)).toContain('Narrate the same captured comparison.');
      expect(requestBodies.at(-1)).toContain('Persisted answer.');
    } finally {
      for (const close of opened.reverse()) await close();
      model.closeAllConnections();
      await new Promise<void>(resolve => model.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
