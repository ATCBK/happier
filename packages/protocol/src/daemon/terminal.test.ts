import { describe, expect, it } from 'vitest';

import { DaemonTerminalEnsureRequestSchema, DaemonTerminalListRequestV1Schema, DaemonTerminalListResponseV1Schema } from './terminal';

describe('daemon terminal listing V1', () => {
  it('admits the read-only projection and rejects unknown authority or process fields', () => {
    expect(DaemonTerminalListRequestV1Schema.parse({})).toEqual({});
    expect(DaemonTerminalListRequestV1Schema.safeParse({ sessionId: 'other' }).success).toBe(false);
    const terminal = { terminalId: 't', terminalKey: 'shell', cwd: '/repo', ended: true, exit: { exitCode: 1, signal: null } };
    expect(DaemonTerminalListResponseV1Schema.parse({ ok: true, terminals: [terminal] })).toEqual({ ok: true, terminals: [terminal] });
    const warning = { v: 1, kind: 'stopping', stopAt: 300_000, rule: 'idle_terminals' };
    expect(DaemonTerminalListResponseV1Schema.parse({ ok: true, terminals: [{ ...terminal, terminalGuardStateV1: warning }] }))
      .toEqual({ ok: true, terminals: [{ ...terminal, terminalGuardStateV1: warning }] });
    expect(DaemonTerminalListResponseV1Schema.safeParse({ ok: true, terminals: [{ ...terminal,
      terminalGuardStateV1: { ...warning, sessionId: 'unrelated-session' } }] }).success).toBe(false);
    expect(DaemonTerminalListResponseV1Schema.safeParse({ ok: true, terminals: [{ ...terminal, env: { TOKEN: 'secret' } }] }).success).toBe(false);
    expect(DaemonTerminalListResponseV1Schema.safeParse({ ok: true, terminals: [{ ...terminal, exit: { exitCode: 1, signal: null, detail: 'secret' } }] }).success).toBe(false);
    expect(DaemonTerminalListResponseV1Schema.safeParse({ ok: false, errorCode: 'terminal_disabled', error: 'disabled', extra: true }).success).toBe(false);
  });
});

describe('DaemonTerminalEnsureRequestSchema', () => {
  it('accepts a typed attached-session action and rejects a competing raw command', () => {
    expect(DaemonTerminalEnsureRequestSchema.parse({
      terminalKey: 'session:dialog-attach',
      launch: { kind: 'session_attach', sessionId: 'session-1' },
    })).toMatchObject({
      launch: { kind: 'session_attach', sessionId: 'session-1' },
    });

    expect(DaemonTerminalEnsureRequestSchema.safeParse({
      terminalKey: 'session:dialog-attach',
      initialCommand: 'happier attach session-1',
      launch: { kind: 'session_attach', sessionId: 'session-1' },
    }).success).toBe(false);
  });

  it('accepts a bounded first-party Happier CLI launch', () => {
    expect(DaemonTerminalEnsureRequestSchema.parse({
      terminalKey: 'provider-login:machine-1:antigravity',
      launch: { kind: 'happier_cli', args: ['agents', 'auth', 'login', 'antigravity'] },
    })).toMatchObject({
      launch: { kind: 'happier_cli', args: ['agents', 'auth', 'login', 'antigravity'] },
    });
  });
  it('accepts an optional sessionId attribution field', () => {
    const parsed = DaemonTerminalEnsureRequestSchema.parse({
      terminalKey: 'terminal-a',
      cwd: '/repo/web',
      sessionId: 'session-a',
    });

    expect(parsed.sessionId).toBe('session-a');
  });

  it('omits sessionId when not supplied (back-compatible)', () => {
    const parsed = DaemonTerminalEnsureRequestSchema.parse({
      terminalKey: 'terminal-a',
      cwd: '/repo/web',
    });

    expect(parsed.sessionId).toBeUndefined();
  });

  it('rejects an empty sessionId', () => {
    const result = DaemonTerminalEnsureRequestSchema.safeParse({
      terminalKey: 'terminal-a',
      sessionId: '',
    });

    expect(result.success).toBe(false);
  });
});
