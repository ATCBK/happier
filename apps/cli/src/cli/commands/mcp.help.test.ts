import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleMcpCommand } from './mcp';
import type { McpCommandDeps } from './mcp/deps';
import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';

afterEach(() => { vi.restoreAllMocks(); process.exitCode = 0; });

describe('happier mcp --help', () => {
  it('prints usage for --help without requiring authentication', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const readStoredCredentials = vi.fn(async () => null);

    try {
      await handleMcpCommand(['--help'], { readStoredCredentials } satisfies Partial<McpCommandDeps>);

      expect(readStoredCredentials).not.toHaveBeenCalled();
      const output = logSpy.mock.calls.flat().join('\n');
      expect(output).toContain('happier mcp');
      expect(output).toContain('happier mcp serve');
      expect(output).toContain('happier mcp servers list');
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('prints usage for `servers --help` without requiring authentication', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const readStoredCredentials = vi.fn(async () => null);

    try {
      await handleMcpCommand(['servers', '--help'], { readStoredCredentials } satisfies Partial<McpCommandDeps>);

      expect(readStoredCredentials).not.toHaveBeenCalled();
      const output = logSpy.mock.calls.flat().join('\n');
      expect(output).toContain('happier mcp servers');
      expect(output).toContain('happier mcp servers list');
      expect(output).toContain('happier mcp servers test');
      expect(output).toContain('happier mcp servers tools');
      expect(output).toContain('happier mcp servers add');
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('prints usage when `servers` subcommand is missing', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const readStoredCredentials = vi.fn(async () => null);

    try {
      await handleMcpCommand(['servers'], { readStoredCredentials } satisfies Partial<McpCommandDeps>);

      expect(readStoredCredentials).not.toHaveBeenCalled();
      const output = logSpy.mock.calls.flat().join('\n');
      expect(output).toContain('happier mcp servers');
      expect(output).toContain('happier mcp servers list');
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('settles an unknown compiled servers leaf as a typed JSON error', async () => {
    const output = captureConsoleJsonOutput<unknown>();
    await handleMcpCommand(['servers', 'unknown', '--json']);
    expect(output.json()).toMatchObject({ ok: false, error: { code: 'unknown_subcommand' } });
    expect(process.exitCode).toBe(1);
  });
});
