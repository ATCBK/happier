import { describe, expect, it, vi } from 'vitest';

import {
  buildOpenCodeSessionMcpProjection,
  canonicalizeOpenCodeProjectedMcpToolName,
  disconnectOpenCodeMcpServers,
  registerOpenCodeMcpServers,
} from './mcpRegistration.js';
import type { OpenCodeRuntimeContext } from './runtimeContext.js';
import type { OpenCodeServerClient } from './openCodeServerClient.js';
import { OpenCodeServerUnsupportedOperationError } from './openCodeServerClient.js';

function createRegistrationHarness() {
  const debug = vi.fn();
  const warn = vi.fn();
  const mcpAdd = vi.fn<OpenCodeServerClient['mcpAdd']>(async () => ({ status: 'connected' }));
  return {
    ctx: {
      logger: { debug, warn },
    } as unknown as OpenCodeRuntimeContext,
    client: { mcpAdd } as unknown as OpenCodeServerClient,
    debug,
    warn,
    mcpAdd,
  };
}

function projection(mcpServers: unknown) {
  return buildOpenCodeSessionMcpProjection('happier-session-1', mcpServers);
}

describe('registerOpenCodeMcpServers', () => {
  it('uses the longest projected alias while preserving original server and known tool names', () => {
    const result = buildOpenCodeSessionMcpProjection('session-a', {
      docs: { command: '/fixture' }, 'docs.team__prod': { command: '/fixture' },
    });
    const alias = result.registrations[1]!.projectedName;
    const policy = { 'docs.team__prod': { unlisted: 'ask' as const, tools: { 'file.read': 'off' as const } } };
    expect(canonicalizeOpenCodeProjectedMcpToolName(`${alias}_file_read`, result, policy)).toBe('mcp__docs.team__prod__file.read');
    expect(canonicalizeOpenCodeProjectedMcpToolName('unknown_search', result, policy)).toBe('unknown_search');
  });
  it('projects every injected server into distinct stable session namespaces', () => {
    const first = buildOpenCodeSessionMcpProjection('session-a', {
      happier: { command: '/bin/happier-mcp' },
      custom: { command: '/bin/custom-mcp' },
    });
    const second = buildOpenCodeSessionMcpProjection('session-b', {
      happier: { command: '/bin/happier-mcp' },
      custom: { command: '/bin/custom-mcp' },
    });

    expect(first.registrations.map(({ originalName, projectedName }) => ({ originalName, projectedName }))).toEqual([
      { originalName: 'happier', projectedName: 'happier-session-session-a--happier' },
      { originalName: 'custom', projectedName: 'happier-session-session-a--custom' },
    ]);
    expect(second.registrations.map(({ projectedName }) => projectedName)).toEqual([
      'happier-session-session-b--happier',
      'happier-session-session-b--custom',
    ]);
    expect(first.requiredHappierServerName).toBe('happier-session-session-a--happier');
  });

  it('keeps long colliding prefixes distinct within the released V2 namespace limit', () => {
    const sharedPrefix = `custom-${'same-prefix-'.repeat(8)}`;
    const result = buildOpenCodeSessionMcpProjection('session-a', {
      [`${sharedPrefix}first`]: { command: '/bin/first' },
      [`${sharedPrefix}second`]: { command: '/bin/second' },
    });
    const names = result.registrations.map(({ projectedName }) => projectedName);

    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
    expect(names).toEqual(names.map((name) => expect.stringMatching(/^[A-Za-z0-9_-]{64}$/)));
    expect(canonicalizeOpenCodeProjectedMcpToolName(
      `${names[0]}_lookup`,
      result,
    )).toBe(`mcp__${sharedPrefix}first__lookup`);
  });

  it('awaits in-flight registration and removes only successfully registered name-directory pairs', async () => {
    const harness = createRegistrationHarness();
    const mcpRemove = vi.fn(async () => undefined);
    let resolveRegistration!: () => void;
    const registration = new Promise<Readonly<{
      requiredHappier: { status: 'ready' };
      registeredServers: readonly Readonly<{ directory: string; name: string }>[];
    }>>((resolve) => {
      resolveRegistration = () => resolve({
        requiredHappier: { status: 'ready' },
        registeredServers: [{ directory: '/repo', name: 'happier-session-session-a--happier' }],
      });
    });

    const cleanup = disconnectOpenCodeMcpServers({
      ctx: harness.ctx,
      client: { mcpRemove } as unknown as OpenCodeServerClient,
      registration,
    });
    await Promise.resolve();
    expect(mcpRemove).not.toHaveBeenCalled();

    resolveRegistration();
    await cleanup;
    expect(mcpRemove).toHaveBeenCalledWith({
      directory: '/repo',
      name: 'happier-session-session-a--happier',
    });
  });

  it('settles required Happier readiness after an earlier optional registration finishes', async () => {
    const harness = createRegistrationHarness();
    let resolveOptional!: () => void;
    harness.mcpAdd.mockImplementation(async ({ name }) => {
      if (name === 'happier-session-happier-session-1--slow_custom') {
        await new Promise<void>((resolve) => {
          resolveOptional = resolve;
        });
      }
      return { status: 'connected' as const };
    });

    const registration = registerOpenCodeMcpServers({
      ctx: harness.ctx,
      client: harness.client,
      directory: '/repo',
      mcpProjection: projection({
        slow_custom: { command: '/bin/custom' },
        happier: { command: '/bin/happier-mcp' },
      }),
    });

    await Promise.resolve();
    expect(harness.mcpAdd).toHaveBeenCalledTimes(1);

    resolveOptional();

    await expect(registration).resolves.toEqual({
      requiredHappier: { status: 'ready' },
      registeredServers: [
        { directory: '/repo', name: 'happier-session-happier-session-1--slow_custom' },
        { directory: '/repo', name: 'happier-session-happier-session-1--happier' },
      ],
    });
    expect(harness.mcpAdd).toHaveBeenNthCalledWith(2, {
      directory: '/repo',
      name: 'happier-session-happier-session-1--happier',
      config: {
        type: 'local',
        enabled: true,
        command: ['/bin/happier-mcp'],
      },
    });
  });

  it('keeps optional failures non-fatal but reports a required Happier failure', async () => {
    const optionalFailureHarness = createRegistrationHarness();
    optionalFailureHarness.mcpAdd
      .mockResolvedValueOnce({ status: 'disabled' })
      .mockResolvedValueOnce({ status: 'connected' });

    await expect(registerOpenCodeMcpServers({
      ctx: optionalFailureHarness.ctx,
      client: optionalFailureHarness.client,
      directory: '/repo',
      mcpProjection: projection({
        optional: { command: '/bin/optional' },
        happier: { command: '/bin/happier-mcp' },
      }),
    })).resolves.toEqual({
      requiredHappier: { status: 'ready' },
      registeredServers: [{ directory: '/repo', name: 'happier-session-happier-session-1--happier' }],
    });

    const requiredFailureHarness = createRegistrationHarness();
    const requiredError = new Error('required add failed');
    requiredFailureHarness.mcpAdd.mockRejectedValueOnce(requiredError);

    await expect(registerOpenCodeMcpServers({
      ctx: requiredFailureHarness.ctx,
      client: requiredFailureHarness.client,
      directory: '/repo',
      mcpProjection: projection({
        happier: { command: '/bin/happier-mcp' },
      }),
    })).resolves.toEqual({
      requiredHappier: { status: 'failed', error: requiredError },
      registeredServers: [],
    });
  });

  it('reports an HTTP-200 non-connected Happier status as a required failure', async () => {
    const harness = createRegistrationHarness();
    harness.mcpAdd.mockResolvedValueOnce({
      status: 'failed',
      error: 'bridge tools unavailable',
    } as never);

    const result = await registerOpenCodeMcpServers({
      ctx: harness.ctx,
      client: harness.client,
      directory: '/repo',
      mcpProjection: projection({
        happier: { command: '/bin/happier-mcp' },
      }),
    });

    expect(result.requiredHappier).toMatchObject({
      status: 'failed',
      error: expect.objectContaining({
        message: expect.stringMatching(/bridge tools unavailable/iu),
      }),
    });
  });

  it('separates a server that cannot take dynamic registrations from one that refused them', async () => {
    const harness = createRegistrationHarness();
    harness.mcpAdd.mockRejectedValue(new OpenCodeServerUnsupportedOperationError({
      operation: 'mcp_registration',
      dialect: 'v2',
      message: 'OpenCode V2 servers expose no dynamic MCP registration route',
    }));

    // The pinned V2 protocol declares no MCP group at all, so there is nothing
    // to fail: the capability is absent. Reporting that as `failed` would make
    // every ordinary V2 prompt fail closed on a route that never existed.
    await expect(registerOpenCodeMcpServers({
      ctx: harness.ctx,
      client: harness.client,
      directory: '/repo',
      mcpProjection: projection({
        optional: { command: '/bin/optional' },
        happier: { command: '/bin/happier-mcp' },
      }),
    })).resolves.toMatchObject({
      requiredHappier: {
        status: 'unsupported',
        reason: expect.stringMatching(/dynamic MCP registration/iu),
      },
    });
    expect(harness.warn).toHaveBeenCalledWith(
      expect.stringContaining('dynamic MCP registration'),
      expect.objectContaining({ dialect: 'v2' }),
    );
  });

  it('reports missing required Happier configuration as a settled failure', async () => {
    const harness = createRegistrationHarness();

    await expect(registerOpenCodeMcpServers({
      ctx: harness.ctx,
      client: harness.client,
      directory: '/repo',
      mcpProjection: projection(undefined),
    })).resolves.toMatchObject({
      requiredHappier: {
        status: 'failed',
        error: expect.objectContaining({
          message: 'required Happier MCP server configuration is missing',
        }),
      },
    });
    expect(harness.mcpAdd).not.toHaveBeenCalled();
  });
});
