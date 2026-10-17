import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { AgentMessage } from '@/agent/core';

import { PiRpcBackend } from './PiRpcBackend';

/**
 * Pi streams `message_start`/`message_end` events for EVERY session message, including
 * user messages. Prompts Happier sends through the RPC `prompt` command echo back as user
 * message events; prompts injected inside Pi (extension `sendUserMessage`, e.g. AFT
 * background-bash completions) also arrive as user message events but have no Happier
 * prompt behind them. The backend must surface only the injected ones.
 */
describe('PiRpcBackend provider-injected user prompts', () => {
  const tempDirs: string[] = [];
  const backends: PiRpcBackend[] = [];

  afterEach(async () => {
    await Promise.all(backends.splice(0).map((backend) => backend.dispose()));
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeFakePiRpcProcessScript(dir: string): string {
    const scriptPath = join(dir, 'fake-pi-rpc-injected-user-message.js');
    const script = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const out = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
let injected = false;

rl.on('line', (line) => {
  let command;
  try {
    command = JSON.parse(line);
  } catch {
    return;
  }

  switch (command.type) {
    case 'new_session':
      out({ id: command.id, type: 'response', command: command.type, success: true, data: { cancelled: false } });
      break;
    case 'get_state':
      out({
        id: command.id,
        type: 'response',
        command: command.type,
        success: true,
        data: {
          sessionId: 'pi-injected-user-message-test',
          model: { id: 'gpt-5.5', provider: 'openai-codex', name: 'GPT-5.5' },
          isStreaming: false,
          isCompacting: false,
        },
      });
      break;
    case 'get_available_models':
      out({
        id: command.id,
        type: 'response',
        command: command.type,
        success: true,
        data: { models: [{ id: 'gpt-5.5', provider: 'openai-codex', name: 'GPT-5.5' }] },
      });
      break;
    case 'get_commands':
      out({ id: command.id, type: 'response', command: command.type, success: true, data: { commands: [] } });
      break;
    case 'prompt': {
      out({ id: command.id, type: 'response', command: command.type, success: true });
      // Pi echoes the accepted prompt as a user message before the run starts.
      out({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: command.message }] } });
      out({ type: 'agent_start' });
      setTimeout(() => out({ type: 'agent_end' }), 20);
      if (!injected) {
        injected = true;
        // An extension (e.g. AFT) injects a background-bash completion prompt into the
        // now-idle session, triggering a fresh provider-initiated run.
        setTimeout(() => {
          out({
            type: 'message_end',
            message: {
              role: 'user',
              content: [{ type: 'text', text: '<system-reminder>\\n[BACKGROUND BASH COMPLETED]\\n- task bash-1 (exit 0)\\n</system-reminder>' }],
            },
          });
          out({ type: 'agent_start' });
          setTimeout(() => out({ type: 'agent_end' }), 20);
        }, 80);
      }
      break;
    }
    default:
      out({ id: command.id, type: 'response', command: command.type, success: true });
      break;
  }
});
`;
    writeFileSync(scriptPath, script, 'utf8');
    chmodSync(scriptPath, 0o755);
    return scriptPath;
  }

  it('suppresses the echo of its own prompts and surfaces only injected user messages', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-pi-injected-user-'));
    tempDirs.push(dir);
    const backend = new PiRpcBackend({
      cwd: dir,
      command: process.execPath,
      args: [makeFakePiRpcProcessScript(dir)],
    });
    backends.push(backend);

    const messages: AgentMessage[] = [];
    backend.onMessage((msg) => {
      messages.push(msg);
    });

    const session = await backend.startSession();
    await backend.sendPrompt(session.sessionId, 'happier sent prompt');

    const injectedText = '<system-reminder>\n[BACKGROUND BASH COMPLETED]\n- task bash-1 (exit 0)\n</system-reminder>';
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (messages.some((msg) => msg.type === 'user-message' && msg.text === injectedText)) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const userMessages = messages.filter((msg) => msg.type === 'user-message');
    expect(userMessages).toEqual([{ type: 'user-message', text: injectedText }]);
  });
});
