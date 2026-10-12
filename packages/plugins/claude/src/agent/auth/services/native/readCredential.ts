import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';

import { resolveHomeDirFromEnvironment } from '@happier-dev/plugin-sdk/fs';

import { resolveConfiguredClaudeConfigDir } from '../../../surfaces/sessions/external/source.js';
import { readClaudeCodeNativeCredentialPayload, type ClaudeCodeNativeCredentialPayload } from './credentials.js';

async function readNativeKeychain(signal?: AbortSignal): Promise<ClaudeCodeNativeCredentialPayload | null> {
  signal?.throwIfAborted();
  // Unit tests must replace the genuine OS boundary before a native Keychain read.
  if (process.env.VITEST && !Object.prototype.hasOwnProperty.call(spawn, 'mock')) {
    throw new Error('claude_code_keychain_real_security_spawn_blocked_in_test');
  }
  const child = spawn('security', [
    'find-generic-password', '-a', userInfo().username, '-s', 'Claude Code-credentials', '-w',
  ], { stdio: ['ignore', 'pipe', 'ignore'], signal });
  const chunks: Buffer[] = [];
  const contents = await new Promise<string>((resolveRead, reject) => {
    child.stdout?.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))));
    child.once('error', reject);
    child.once('close', status => resolveRead(status === 0 ? Buffer.concat(chunks).toString('utf8') : ''));
  });
  signal?.throwIfAborted();
  return readClaudeCodeNativeCredentialPayload(JSON.parse(contents));
}

export async function readClaudeCodeNativeCredential(params: Readonly<{
  signal?: AbortSignal;
}>): Promise<ClaudeCodeNativeCredentialPayload | null> {
  const { signal } = params;
  signal?.throwIfAborted();
  // Deliberate trusted OS boundary: only explicit native-import authentication calls this
  // reader on the host-admitted machine. Workspace filesystem grants do not cover native login
  // files or Keychain; callers choose a declared source, never an arbitrary path.
  const configDir = resolveConfiguredClaudeConfigDir({ env: process.env });
  const homeDir = resolveHomeDirFromEnvironment(process.env);
  if (process.platform === 'darwin' && resolve(configDir) === resolve(join(homeDir, '.claude'))) {
    try {
      const credential = await readNativeKeychain(signal);
      if (credential) return credential;
    } catch {
      signal?.throwIfAborted();
    }
  }
  try {
    const contents = await readFile(join(configDir, '.credentials.json'), { encoding: 'utf8', signal });
    signal?.throwIfAborted();
    return readClaudeCodeNativeCredentialPayload(JSON.parse(contents));
  } catch {
    signal?.throwIfAborted();
    return null;
  }
}
