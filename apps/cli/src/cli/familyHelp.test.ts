import { expect, it } from 'vitest';
import { captureConsoleLogAndMuteStdout } from '@/testkit/logger/captureOutput';
import { tryPrintFamilyHelp } from './familyHelp';

it.each([
  ['logout', 'Authentication management'],
  ['status', 'Usage: happier status'],
  ['tools', 'Usage: happier tools'],
  ['acp-catalog', 'Usage: happier acp-catalog'],
  ['completion', 'Usage: happier completion'],
  ['browser', 'managed Chromium'],
  ['setup', 'Choose or create a Home'],
  ['mcp', 'happier mcp serve'],
  ['bridge', 'happier mcp serve'],
  ['connect', 'happier connect'],
  ['agents', 'Agent CLI helpers'],
  ['agent', 'Agent CLI helpers'],
  ['plugins', 'Plugin discovery, local authoring'],
  ['install', 'Installation helpers'],
  ['home', 'Create, connect, and administer'],
  ['machines', 'Discover machines'],
  ['actions', 'Discover and invoke'],
  ['session', 'happier session'],
  ['sessions', 'happier session'],
  ['spawn', 'happier spawn'],
  ['history', 'happier history'],
  ['delegate', 'happier delegate'],
])('keeps %s help local without invoking its command', async (root, expected) => {
  const output = captureConsoleLogAndMuteStdout();
  try {
    expect(await tryPrintFamilyHelp([root, '--help'])).toBe(true);
    expect([...output.logs, ...output.stdoutChunks].join('\n')).toContain(expected);
  } finally { output.restore(); }
});

it('does not reinterpret help after the argument terminator', async () => {
  expect(await tryPrintFamilyHelp(['provider', '--', '--help'])).toBe(false);
});

it.each([
  ['send', 'session-1', 'help'],
  ['session', 'send', 'session-1', 'help'],
  ['session', 'title', 'session-1', 'help'],
  ['send', 'help'],
  ['spawn', 'help'],
  ['resume', 'help'],
  ['attach', 'help'],
  ['service', 'help'],
  ['completion', 'help'],
])('does not reinterpret positional help bytes in %j', async (...args) => {
  expect(await tryPrintFamilyHelp(args)).toBe(false);
});

it.each(['auth', 'provider', 'profile', 'agents', 'session', 'teams', 'browser'])('retains the %s family help subcommand', async (root) => {
  const output = captureConsoleLogAndMuteStdout();
  try {
    expect(await tryPrintFamilyHelp([root, 'help'])).toBe(true);
    expect([...output.logs, ...output.stdoutChunks].join('\n')).not.toBe('');
  } finally { output.restore(); }
});

it.each([
  ['attach', 'happier attach\nhappier attach <session-id-or-prefix>\n\nAttaches a terminal to a running session on this computer.'],
  ['resume', 'happier resume [<session-id-or-prefix>]\n\nAttaches to a running session, or resumes a stopped session when supported.'],
])('preserves the existing dedicated %s help bytes', async (root, expected) => {
  const output = captureConsoleLogAndMuteStdout();
  try {
    expect(await tryPrintFamilyHelp([root, '--help'])).toBe(true);
    expect(output.logs.join('\n')).toBe(expected);
  } finally { output.restore(); }
});

it.each([
  [['list'], 'session_list'],
  [['ls'], 'session_list'],
  [['send'], 'session_send'],
  [['stop'], 'session_stop'],
  [['wait'], 'wait'],
  [['session', 'wait'], 'session_wait'],
  [['session', 'run', 'send'], 'session_run_send'],
  [['session', 'status'], 'session_status'],
])('preserves the published JSON envelope for %j', async (path, kind) => {
  const output = captureConsoleLogAndMuteStdout();
  try {
    expect(await tryPrintFamilyHelp([...path, '--help', '--json'])).toBe(true);
    expect(JSON.parse(output.stdoutChunks.join(''))).toMatchObject({ v: 1, ok: true, kind, data: { help: expect.any(String) } });
  } finally { output.restore(); }
});

it.each([
  [['auth', 'api-tokens', '--help'], 'Usage: happier auth api-tokens'],
  [['auth', 'security', 'get', '--help'], 'Usage: happier auth security get'],
  [['mcp', 'serve', '--help'], 'happier mcp serve [--session <session-id>]'],
  [['browser', 'sandbox', 'install', '--help'], 'executable-scoped AppArmor'],
  [['relay', 'host', 'install', '--help'], 'Advanced/operator server runtime deployment'],
  [['session', 'create', '--help'], 'happier session create'],
  [['plugins', 'settings', '--help', '--json'], '"kind":"plugins.settings"'],
  [['teams', '--help'], 'Action-backed teams commands'],
])('retains dedicated or compiled nested help for %j', async (args, expected) => {
  const output = captureConsoleLogAndMuteStdout();
  try {
    expect(await tryPrintFamilyHelp(args)).toBe(true);
    expect([...output.logs, ...output.stdoutChunks].join('\n').replaceAll(' ', '')).toContain(expected.replaceAll(' ', ''));
  } finally { output.restore(); }
});
