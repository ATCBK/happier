import { describe, expect, it } from 'vitest';

import { extractShellCommand, stripShellCommandPreludeForDisplay } from './shellCommand.js';

describe('extractShellCommand', () => {
  it('unwraps the persisted native commandExecution input', () => {
    // c29 initial/ordinary-history-final.json: native Bash input carries both fields.
    expect(extractShellCommand({ command: '/bin/bash -lc pwd', cmd: '/bin/bash -lc pwd' })).toBe('pwd');
    expect(extractShellCommand({ cmd: '/bin/bash -lc pwd' })).toBe('pwd');
  });

  it.each([
    ["/bin/bash -lc 'ls -la'", 'ls -la'],
    ['/bin/zsh -lc "ls -la"', 'ls -la'],
    [String.raw`bash -lc 'printf '\''%s\n'\'' '\''hello world'\'''`, String.raw`printf '%s\n' 'hello world'`],
    [String.raw`zsh -lc "printf '%s\n' \"hello world\""`, String.raw`printf '%s\n' "hello world"`],
    [String.raw`bash -lc "printf '%s' \$HOME"`, "printf '%s' $HOME"],
    [String.raw`bash -lc ls\ -la`, 'ls -la'],
    ["bash -lc ''", ''],
  ])('unwraps a shell-joined script without changing its contents: %s', (command, script) => {
    expect(extractShellCommand({ command })).toBe(script);
  });

  it.each([
    'git status --short',
    "printf '%s' 'hello world'",
    "/bin/bash -lc 'ls -la",
    '/bin/zsh -lc "ls -la',
    'bash -lc pwd\\',
    'bash -lc pwd; touch /tmp/other',
    'bash -lc pwd && touch /tmp/other',
    'bash -lc pwd > /tmp/other',
    'bash -lc "$(touch /tmp/other)pwd"',
    'bash -lc "$COMMAND"',
    'bash -lc `echo pwd`',
    'bash -lc p*d',
    'bash -lc #comment',
    'bash -lc pwd extra',
    'bash -c pwd',
  ])('keeps non-wrappers and ambiguous shell strings unchanged: %s', (command) => {
    expect(extractShellCommand({ command })).toBe(command);
  });

  it('extracts a command from argv arrays', () => {
    expect(extractShellCommand(JSON.stringify({ argv: ['/bin/bash', '-lc', 'ls -la'] }))).toBe('ls -la');
  });

  it('extracts nested commands from toolCall.rawInput', () => {
    expect(
      extractShellCommand(JSON.stringify({ toolCall: { rawInput: { command: ['/bin/zsh', '-lc', 'git status'] } } })),
    ).toBe('git status');
  });

  it('extracts command text from execute toolCall titles', () => {
    expect(
      extractShellCommand({
        toolCall: {
          kind: 'execute',
          title: 'git status --short',
        },
      }),
    ).toBe('git status --short');
  });

  it('falls back to execute toolCall titles when rawInput has no command', () => {
    expect(
      extractShellCommand({
        toolCall: {
          kind: 'execute',
          rawInput: {
            title: 'Shell',
            description: 'Shell',
          },
          title: 'git status --short',
        },
      }),
    ).toBe('git status --short');
  });

  it('extracts command text from shell-like toolCall titles', () => {
    expect(
      extractShellCommand({
        toolCall: {
          kind: 'other',
          toolName: 'Bash',
          title: 'pnpm test',
        },
      }),
    ).toBe('pnpm test');
  });

  it('does not extract command text from generic execute titles', () => {
    expect(
      extractShellCommand({
        toolCall: {
          kind: 'execute',
          title: 'Run shell command',
        },
      }),
    ).toBeNull();
    expect(
      extractShellCommand({
        toolCall: {
          kind: 'execute',
          title: 'bash',
        },
      }),
    ).toBeNull();
  });

  it('extracts command text from prefixed execute toolCall titles', () => {
    expect(
      extractShellCommand({
        toolCall: {
          kind: 'execute',
          title: 'Run terminal command: git status --short',
        },
      }),
    ).toBe('git status --short');
  });

  it('extracts a command from raw argv arrays', () => {
    expect(extractShellCommand(['echo', 'hi'])).toBe('echo hi');
  });

  it('returns null for malformed or non-object inputs', () => {
    expect(extractShellCommand('{not-json')).toBeNull();
    expect(extractShellCommand('hello')).toBeNull();
  });
});

describe('stripShellCommandPreludeForDisplay', () => {
  it('removes env assignments and unset prelude noise', () => {
    expect(
      stripShellCommandPreludeForDisplay(
        'FOO=bar unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN; git status --short',
      ),
    ).toBe('git status --short');
  });
});
