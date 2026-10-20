import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { CLAUDE_NATIVE_CATALOG_COMMAND, parseClaudeNativeCatalogsOutput } from './catalogs.js';

it.runIf(Boolean(process.env.HAPPIER_TEST_NATIVE_CLAUDE_PATH))('initializes native catalogs without persisting probes while an ordinary conversation persists', async () => {
    const nativePath = process.env.HAPPIER_TEST_NATIVE_CLAUDE_PATH!;
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-native-catalog-'));
    const configDir = join(root, 'claude');
    const projectDir = join(root, 'project');
    await mkdir(configDir);
    await mkdir(projectDir);
    // Native Claude 2.1.296 uses the actual HTTP/SSE boundary. No account,
    // credentials or external provider service participates in this check.
    const server = createServer(async (request, response) => {
        let body = '';
        for await (const chunk of request) body += chunk.toString();
        if (request.url?.includes('count_tokens')) {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ input_tokens: 1 }));
            return;
        }
        if (!request.url?.includes('/v1/messages')) {
            response.writeHead(404);
            response.end('{}');
            return;
        }
        const input = JSON.parse(body) as { model: string };
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const event of [
            { type: 'message_start', message: { id: 'msg_local', type: 'message', role: 'assistant', model: input.model,
                content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
            { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Local native test response.' } },
            { type: 'content_block_stop', index: 0 },
            { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
            { type: 'message_stop' },
        ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        response.end();
    });
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing localhost boundary address');

    async function run(args: readonly string[], stdin: string, entrypoint: string) {
        const child = spawn(nativePath, args, { cwd: projectDir, env: {
            PATH: process.env.PATH, NODE_ENV: 'test', TERM: 'dumb',
            CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_ENTRYPOINT: entrypoint,
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
            ANTHROPIC_BASE_URL: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`,
            ANTHROPIC_API_KEY: 'local-test-key',
        }, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
        try {
            const exitCode = await new Promise<number | null>((resolve, reject) => {
                child.once('error', reject);
                child.once('close', resolve);
                child.stdin.end(stdin);
            });
            return { ok: exitCode === 0, exitCode, stdout, stderr };
        } finally {
            child.kill();
        }
    }

    try {
        const command = CLAUDE_NATIVE_CATALOG_COMMAND;
        const args = command.prepareCommand({ accountSettings: null, environment: {},
            pluginSettings: { account: { claudeRemoteSettingSources: 'none' } } }).args;
        for (const entrypoint of ['happier', 'cli']) {
            const result = await run(args, command.stdin, entrypoint);
            expect(result.exitCode, result.stderr).toBe(0);
            expect(parseClaudeNativeCatalogsOutput(result).commands.length).toBeGreaterThan(0);
            expect((await readdir(configDir, { recursive: true })).filter(path => path.endsWith('.jsonl'))).toEqual([]);
        }

        const interactive = await run(['--print', '--input-format', 'stream-json', '--output-format', 'stream-json',
            '--permission-prompt-tool', 'stdio',
            '--verbose', '--setting-sources', '', '--model', 'claude-sonnet-4-6'], command.stdin + JSON.stringify({
                type: 'user', message: { role: 'user', content: 'interactive persistence control' },
            }) + '\n', 'happier');
        expect(interactive.exitCode, interactive.stderr).toBe(0);
        const frames = interactive.stdout.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
        const result = frames.find(frame => frame.type === 'result');
        expect(result).toMatchObject({ subtype: 'success' });
        const init = frames.find(frame => frame.type === 'system' && frame.subtype === 'init');
        expect(init?.tools).toEqual(expect.arrayContaining(['Read', 'AskUserQuestion']));
        const files = await readdir(join(configDir, 'projects'), { recursive: true });
        const transcripts = files.filter(path => path.endsWith('.jsonl'));
        expect(transcripts.map(path => path.split(/[\\/]/).at(-1))).toEqual([`${init?.session_id}.jsonl`]);
        const text = await readFile(join(configDir, 'projects', transcripts[0]), 'utf8');
        expect(text).toContain('interactive persistence control');
        expect(text).toContain('Local native test response.');
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        await rm(root, { recursive: true, force: true });
    }
}, 60_000);
