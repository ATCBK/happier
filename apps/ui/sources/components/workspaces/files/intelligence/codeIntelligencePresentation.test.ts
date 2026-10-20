import { describe, expect, it, vi } from 'vitest';

import type { CodeIntelligenceSnapshot } from '@/sync/domains/workspaces/languageIntelligence/createCodeIntelligenceController';

import {
  formatProblemsFact,
  groupCodeProblems,
  readCodeHoverContent,
  resolveLanguageStateNote,
} from './codeIntelligencePresentation';

vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock();
});

const idle: CodeIntelligenceSnapshot = {
  mode: 'server',
  status: 'idle',
  selection: null,
  querySelection: null,
  kind: null,
  result: null,
};
const server = (
  state: 'starting' | 'ready' | 'crashed' | 'unavailable',
  extra: Record<string, unknown> = {},
) =>
  ({
    serverId: 'ts',
    label: 'TypeScript',
    state,
    loading: false,
    generation: 'g1',
    ...extra,
  }) as NonNullable<CodeIntelligenceSnapshot['servers']>[number];

describe('language intelligence presentation', () => {
  it('counts problems only from a confirmed answer, never while checking or empty', () => {
    expect(
      formatProblemsFact({ state: 'checking', count: null, errors: 0 }),
    ).toBeNull();
    expect(
      formatProblemsFact({ state: 'ready', count: 0, errors: 0 }),
    ).toBeNull();
    expect(
      formatProblemsFact({ state: 'unavailable', count: null, errors: 0 }),
    ).toBeNull();
    expect(
      formatProblemsFact({ state: 'ready', count: 3, errors: 3 }),
    ).not.toBeNull();
  });

  it('says one state at a time: progress while starting or loading, failure with Restart, nothing when ready', () => {
    expect(
      resolveLanguageStateNote({
        snapshot: { ...idle, servers: [server('ready')] },
        machineName: 'devbox',
        machineUnreachable: false,
      }),
    ).toBeNull();
    expect(
      resolveLanguageStateNote({
        snapshot: { ...idle, servers: [server('starting')] },
        machineName: 'devbox',
        machineUnreachable: false,
      })?.kind,
    ).toBe('progress');
    expect(
      resolveLanguageStateNote({
        snapshot: { ...idle, servers: [server('ready', { loading: true })] },
        machineName: 'devbox',
        machineUnreachable: false,
      })?.kind,
    ).toBe('progress');
    const crashed = resolveLanguageStateNote({
      snapshot: {
        ...idle,
        servers: [server('crashed', { stderrPreview: 'a\nb\nc\nlast' })],
      },
      machineName: 'devbox',
      machineUnreachable: false,
    });
    expect(crashed).toMatchObject({
      kind: 'failure',
      action: 'restart',
      detail: 'b\nc\nlast',
    });
    expect(
      resolveLanguageStateNote({
        snapshot: {
          ...idle,
          status: 'unavailable',
          reason: 'transport_failed',
        },
        machineName: 'devbox',
        machineUnreachable: true,
      })?.kind,
    ).toBe('failure');
  });

  it('reads the signature from the first fenced block and keeps the prose as documentation', () => {
    const content = readCodeHoverContent({
      status: 'ok',
      kind: 'hover',
      sections: [
        {
          serverId: 'ts',
          label: 'TypeScript',
          markdown:
            '```typescript\nfunction retry<T>(fn: () => Promise<T>): Promise<T>\n```\n---\nRetries with backoff.',
        },
      ],
    } as CodeIntelligenceSnapshot['result']);
    expect(content).toEqual({
      signature: {
        code: 'function retry<T>(fn: () => Promise<T>): Promise<T>',
        language: 'typescript',
      },
      documentation: 'Retries with backoff.',
      serverLabel: 'TypeScript',
    });
    expect(
      readCodeHoverContent({
        status: 'ok',
        kind: 'hover',
        sections: [],
      } as CodeIntelligenceSnapshot['result']),
    ).toBeNull();
  });

  it('groups problems by server, then by file in reading order', () => {
    const at = (path: string, line: number, serverId = 'ts') => ({
      serverId,
      path,
      severity: 'error' as const,
      message: `m${line}`,
      range: { start: { line, character: 0 }, end: { line, character: 1 } },
    });
    const groups = groupCodeProblems(
      [at('b.ts', 4), at('a.ts', 9), at('a.ts', 2), at('a.ts', 1, 'eslint')],
      [
        server('ready'),
        { ...server('ready'), serverId: 'eslint', label: 'ESLint' },
      ],
    );
    expect(groups.map((group) => group.serverLabel)).toEqual([
      'TypeScript',
      'ESLint',
    ]);
    expect(
      groups[0].files.map((file) => [
        file.path,
        file.items.map((item) => item.range.start.line),
      ]),
    ).toEqual([
      ['a.ts', [2, 9]],
      ['b.ts', [4]],
    ]);
  });
});
