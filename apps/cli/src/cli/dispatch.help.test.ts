import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureConsoleLogAndMuteStdout } from '@/testkit/logger/captureOutput';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { reloadConfiguration } from '@/configuration';
import packageJson from '../../package.json';

import { dispatchCli } from './dispatch';

describe('dispatchCli root help', () => {
  let output = captureConsoleLogAndMuteStdout();
  let envScope = createEnvKeyScope([
    'HAPPIER_SERVER_URL',
    'HAPPIER_WEBAPP_URL',
    'HAPPIER_PUBLIC_SERVER_URL',
    'HAPPIER_LOCAL_SERVER_URL',
  ]);

  beforeEach(() => {
    envScope = createEnvKeyScope([
      'HAPPIER_SERVER_URL',
      'HAPPIER_WEBAPP_URL',
      'HAPPIER_PUBLIC_SERVER_URL',
      'HAPPIER_LOCAL_SERVER_URL',
    ]);
    output.restore();
    output = captureConsoleLogAndMuteStdout();
  });

  afterEach(() => {
    envScope.restore();
    reloadConfiguration();
    output.restore();
  });

  it.each([
    ['--help'],
    ['--server-url', 'http://127.0.0.1:53288', '--webapp-url', 'http://app.example.test', '--help'],
  ])('prints vendor-agnostic root help after global prefixes: %j', async (...args) => {
    await dispatchCli({
      args,
      rawArgv: ['happier', ...args],
      terminalRuntime: null,
    });

    // The brand banner, like every other titled page.
    expect(output.logs.join('\n').replace(/\u001b\[[0-9;]*m/gu, '')).toMatch(/^Happier\nRun, watch and steer your coding agents from any device\.$/mu);
    expect(output.logs).toContainEqual(expect.stringContaining('happier codex'));
    expect(output.logs).toContainEqual(expect.stringContaining('happier credentials'));
    expect(output.logs).toContainEqual(expect.stringContaining('happier secrets'));
    expect(output.logs).toContainEqual(expect.stringContaining('happier resume [<session-id-or-prefix>]'));
    expect(output.logs).toContainEqual(expect.stringContaining('happier --api-token <token>'));
    expect(output.logs).toContainEqual(expect.stringContaining('Create API Tokens in Settings'));
    expect(output.logs.join('\n')).not.toMatch(/^\s*happier sessions(?:\s|$)/m);
    expect(output.logs).not.toContainEqual(expect.stringContaining('Claude Code Options'));
  });

  it('routes capabilities JSON requests without invoking the default backend handler', async () => {
    await dispatchCli({
      args: ['capabilities', '--json'],
      rawArgv: ['happier', 'capabilities', '--json'],
      terminalRuntime: null,
    });

    expect(output.stdoutChunks).toContainEqual(expect.stringContaining('"kind":"capabilities_describe"'));
  });

  it('prints version after prefix-only server selection flags without invoking the default backend handler', async () => {
    await dispatchCli({
      args: [
        '--server-url',
        'http://127.0.0.1:53288',
        '--webapp-url',
        'http://app.example.test',
        '--version',
      ],
      rawArgv: [
        'happier',
        '--server-url',
        'http://127.0.0.1:53288',
        '--webapp-url',
        'http://app.example.test',
        '--version',
      ],
      terminalRuntime: null,
    });

    expect(output.logs).toEqual([packageJson.version]);
  });

  it('routes the hidden plural sessions compatibility alias without invoking the default backend handler', async () => {
    await dispatchCli({
      args: ['sessions', '--help'],
      rawArgv: ['happier', 'sessions', '--help'],
      terminalRuntime: null,
    });

  });

  it('routes the singular agent alias without invoking the default backend handler', async () => {
    await dispatchCli({
      args: ['agent', '--help'],
      rawArgv: ['happier', 'agent', '--help'],
      terminalRuntime: null,
    });

    expect(output.logs.join('\n')).toContain('happier agents');
  });

  it('routes the singular provider alias to the model-provider help surface', async () => {
    await dispatchCli({
      args: ['provider', '--help'],
      rawArgv: ['happier', 'provider', '--help'],
      terminalRuntime: null,
    });

    expect(output.logs.join('\n')).toContain('Manage model-provider connections');
  });

  it.each([
    ['agent', 'happier agents'],
    ['provider', 'Manage model-provider connections'],
    ['profile', 'happier profiles'],
    ['bridge', 'happier mcp serve'],
    ['sessions', 'happier session'],
    ['automations', 'happier automation'],
    ['self-update', 'happier self'],
    ['ls', 'happier ls'],
  ])('keeps normalized %s alias help on the local help path', async (root, expected) => {
    const args = ['--server-url', 'http://127.0.0.1:53288', root, '--help'];
    await dispatchCli({ args, rawArgv: ['happier', ...args], terminalRuntime: null });
    expect([...output.logs, ...output.stdoutChunks].join('\n')).toContain(expected);
  });
});
