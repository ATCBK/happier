import { describe, expect, it } from 'vitest';

import {
  detectOpenCodeCliAuthStatus,
  extractOpenCodeCliAuthAccountLabel,
} from './auth.js';

describe('OpenCode CLI auth helpers', () => {
  it('extracts account labels from auth list output', () => {
    expect(extractOpenCodeCliAuthAccountLabel('OpenAI alice@example.com oauth')).toBe('alice@example.com');
    expect(extractOpenCodeCliAuthAccountLabel('logged in as bob@example.test')).toBe('bob@example.test');
    expect(extractOpenCodeCliAuthAccountLabel('no account')).toBeNull();
  });

  it('interprets a successful bounded auth-list command without raw credential fallback', async () => {
    await expect(detectOpenCodeCliAuthStatus({
      runAuthList: async () => ({ ok: true, stdout: 'OpenAI alice@example.com oauth' }),
    })).resolves.toEqual({
      state: 'logged_in',
      method: 'oauth_cli',
      source: 'command',
      accountLabel: 'alice@example.com',
    });
  });

  it('reports missing credentials when auth list output is empty', async () => {
    await expect(detectOpenCodeCliAuthStatus({
      runAuthList: async () => ({ ok: true, stdout: '   ' }),
    })).resolves.toEqual({
      state: 'logged_out',
      reason: 'missing_credentials',
      source: 'command',
      method: 'oauth_cli',
      accountLabel: null,
    });
  });

  it('reports missing credentials for the native empty credential inventory', async () => {
    // OpenCode 1.19.0 prints its inventory heading even when no credentials exist.
    await expect(detectOpenCodeCliAuthStatus({
      runAuthList: async () => ({ ok: true, stdout: '┌  Credentials ~/.local/share/opencode/auth.json\n│\n└  0 credentials\n' }),
    })).resolves.toMatchObject({ state: 'logged_out', reason: 'missing_credentials', accountLabel: null });
  });

  it.each([
    '┌  Credentials ~/.local/share/opencode/auth.json\n│  ●  OpenAI oauth\n└  1 credential\n',
    '┌  Credentials ~/.local/share/opencode/auth.json\n└  0 credentials\n┌  Environment\n│  ●  OpenAI OPENAI_API_KEY\n└  1 environment variable\n',
  ])('retains sign-in for a populated native credential or environment inventory', async (stdout) => {
    await expect(detectOpenCodeCliAuthStatus({
      runAuthList: async () => ({ ok: true, stdout }),
    })).resolves.toMatchObject({ state: 'logged_in', method: 'oauth_cli', source: 'command' });
  });

  it('reports missing credentials when auth list command fails', async () => {
    await expect(detectOpenCodeCliAuthStatus({
      runAuthList: async () => ({ ok: false, stdout: '' }),
    })).resolves.toEqual({
      state: 'logged_out',
      reason: 'missing_credentials',
      source: 'command',
      method: 'oauth_cli',
      accountLabel: null,
    });
  });

});
