import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { captureConsoleText } from '@/testkit/logger/captureOutput';

const actionExecution = vi.hoisted(() => ({
  readCredentials: vi.fn(),
  createExecutor: vi.fn(),
  execute: vi.fn(),
}));

vi.mock('@/persistence', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/persistence')>(),
  readStoredCredentials: actionExecution.readCredentials,
}));

vi.mock('@/session/actions/createCliActionExecutorFromCredentials', () => ({
  createCliActionExecutorFromCredentials: (params: unknown) => {
    actionExecution.createExecutor(params);
    return { execute: actionExecution.execute };
  },
}));

import { handlePluginsCommand } from './plugins';

const TEST_CREDENTIALS = Object.freeze({
  token: 'test-token',
  encryption: null,
  credentialProvenance: 'stored_session' as const,
});

function settingsCommandDeps(execute: ReturnType<typeof vi.fn>) {
  return {
    pluginSettings: {
      readCredentialsFn: async () => TEST_CREDENTIALS,
      createExecutorFn: async () => ({ execute }),
    },
  } as const;
}

beforeEach(() => {
  actionExecution.readCredentials.mockReset();
  actionExecution.createExecutor.mockReset();
  actionExecution.execute.mockReset();
  process.exitCode = undefined;
});

afterEach(() => {
  process.exitCode = undefined;
});

describe('plugin Settings administration CLI', () => {
  it('advertises scope-selected Settings administration', async () => {
    // Help labels name the invoking invoker; pin the documented default lane
    // instead of inheriting the test runner's argv-derived invoker.
    const envScope = createEnvKeyScope(['HAPPIER_CLI_INVOKER_NAME']);
    envScope.patch({ HAPPIER_CLI_INVOKER_NAME: 'happier' });
    const output = captureConsoleText();
    try {
      await handlePluginsCommand(['help']);

      expect(output.text()).toContain(
        'happier plugins settings list <pluginId> --scope <account|daemon> [--machine <id>] [--json]',
      );
      expect(output.text()).toContain(
        'happier plugins settings get <pluginId> <localId> --scope <account|daemon> [--machine <id>] [--json]',
      );
      expect(output.text()).toContain(
        'happier plugins settings set <pluginId> <localId> --scope <account|daemon> --value <json> [--expected-revision <revision>] [--machine <id>] [--json]',
      );
      expect(output.text()).toContain(
        'happier plugins settings reset <pluginId> <localId> --scope <account|daemon> [--expected-revision <revision>] [--machine <id>] [--json]',
      );
      expect(output.text()).toContain(
        'happier plugins settings secret status <pluginId> <localId> [--scope <account|daemon>] [--machine <id>] [--json]',
      );
      expect(output.text()).toContain(
        'happier plugins settings secret bind <pluginId> <localId> --saved-secret-id <id> [--scope <account|daemon>] [--expected-revision <revision>] [--json]',
      );
      expect(output.text()).toContain(
        'happier plugins settings secret unbind <pluginId> <localId> [--scope <account|daemon>] [--expected-revision <revision>] [--json]',
      );
      expect(output.text()).toContain(
        'happier plugins settings secret delete <pluginId> <localId> [--scope <account|daemon>] [--machine <id>] [--expected-revision <revision>] [--json]',
      );
    } finally {
      output.restore();
      envScope.restore();
    }
  });

  it('serves nested Settings help without authentication or execution', async () => {
    const output = captureConsoleText();
    try {
      await handlePluginsCommand(['settings', '--help']);

      expect(output.text()).toContain('plugins settings set <pluginId> <localId>');
      expect(actionExecution.readCredentials).not.toHaveBeenCalled();
      expect(actionExecution.execute).not.toHaveBeenCalled();
    } finally {
      output.restore();
    }
  });

  it('routes the root settings command through the canonical credentialed Action executor', async () => {
    const credentials = {
      token: 'account-token',
      encryption: null,
      credentialProvenance: 'stored_session' as const,
    };
    actionExecution.readCredentials.mockResolvedValueOnce(credentials);
    actionExecution.execute.mockResolvedValueOnce({
      ok: true,
      result: {
        ok: true,
        kind: 'plugins.settings.secret.status',
        data: {
          localId: 'daemon-token',
          custody: 'daemon',
          target: { kind: 'daemon', serverIdentityId: 'srv_settings_1', machineId: 'machine-1' },
          state: 'missing',
          revision: 'daemon-secret-r1:missing',
        },
      },
    });
    const resolvePluginInvocationLogTarget = vi.fn(async () => ({
      kind: 'selected' as const,
      target: {
        serverIdentityId: 'srv_settings_1',
        serverLabel: 'Settings Home',
        serverUrl: 'https://settings.example.test',
        machineId: 'machine-1',
        machineLabel: 'Settings Machine',
      },
    }));
    const output = captureConsoleText();
    try {
      await handlePluginsCommand([
        'settings', 'secret', 'status', 'acme.settings', 'daemon-token', '--machine', 'machine-1', '--json',
      ], { resolvePluginInvocationLogTarget });

      expect(actionExecution.readCredentials).toHaveBeenCalledOnce();
      expect(actionExecution.createExecutor).toHaveBeenCalledWith({ credentials });
      expect(actionExecution.execute).toHaveBeenCalledWith(
        'plugins.settings.secret.status',
        {
          pluginId: 'acme.settings',
          localId: 'daemon-token',
          secretDaemonTarget: { kind: 'daemon', serverIdentityId: 'srv_settings_1', machineId: 'machine-1' },
        },
        { surface: 'cli', defaultSessionId: null, actionRequestId: expect.any(String) },
      );
      expect(JSON.parse(output.text())).toMatchObject({
        ok: true,
        kind: 'plugins.settings.secret.status',
        data: {
          localId: 'daemon-token',
          custody: 'daemon',
          target: { kind: 'daemon', serverIdentityId: 'srv_settings_1', machineId: 'machine-1' },
          state: 'missing',
          revision: 'daemon-secret-r1:missing',
        },
      });
    } finally {
      output.restore();
    }
  });

  it('parses a non-secret compare-and-set mutation into the canonical Settings administration action', async () => {
    const execute = vi.fn(async () => ({
      ok: true,
      result: {
        ok: true,
        kind: 'plugins.settings.set',
        data: { revision: '8' },
      },
    }));
    const output = captureConsoleText();
    try {
      await handlePluginsCommand([
        'settings',
        'set',
        'acme.settings',
        'theme',
        '--scope',
        'account',
        '--value',
        '"dark"',
        '--expected-revision',
        '7',
        '--json',
      ], settingsCommandDeps(execute));

      expect(execute).toHaveBeenCalledWith(
        'plugins.settings.set',
        {
          pluginId: 'acme.settings',
          scope: { kind: 'account' },
          target: { kind: 'account' },
          localId: 'theme',
          value: 'dark',
          expectedRevision: '7',
        },
        { surface: 'cli', defaultSessionId: null, actionRequestId: expect.any(String) },
      );
    } finally {
      output.restore();
    }
  });

  it('preserves the shared deferred-approval result instead of treating it as invalid Settings output', async () => {
    const execute = vi.fn(async () => ({
      ok: true,
      result: { kind: 'approval_request_created', artifactId: 'approval-settings-1' },
    }));
    const output = captureConsoleText();
    try {
      await handlePluginsCommand([
        'settings', 'reset', 'acme.settings', 'theme', '--scope', 'account', '--json',
      ], settingsCommandDeps(execute));

      expect(JSON.parse(output.text())).toMatchObject({
        ok: true,
        kind: 'plugins.settings.reset',
        data: { kind: 'approval_request_created', artifactId: 'approval-settings-1' },
      });
    } finally {
      output.restore();
    }
  });

  it('preserves canonical Action failure codes in the Settings JSON envelope', async () => {
    const execute = vi.fn(async () => ({
      ok: false,
      errorCode: 'plugin_settings_revision_conflict',
      error: 'Plugin Settings changed before the update.',
    }));
    const output = captureConsoleText();
    try {
      await handlePluginsCommand([
        'settings', 'reset', 'acme.settings', 'theme', '--scope', 'account', '--expected-revision', '7', '--json',
      ], settingsCommandDeps(execute));

      expect(JSON.parse(output.text())).toMatchObject({
        ok: false,
        kind: 'plugins.settings.reset',
        error: {
          code: 'plugin_settings_revision_conflict',
          message: 'Plugin Settings changed before the update.',
        },
      });
    } finally {
      output.restore();
    }
  });

  it('parses list, get, and reset through the same scope-selected action family', async () => {
    const execute = vi.fn(async (actionId: string) => ({
      ok: true,
      result: { ok: true, kind: actionId, data: {} },
    }));
    const output = captureConsoleText();
    try {
      await handlePluginsCommand([
        'settings', 'list', 'acme.settings', '--scope', 'account', '--json',
      ], settingsCommandDeps(execute));
      await handlePluginsCommand([
        'settings', 'get', 'acme.settings', 'theme', '--scope', 'account', '--json',
      ], settingsCommandDeps(execute));
      await handlePluginsCommand([
        'settings', 'reset', 'acme.settings', 'theme', '--scope', 'account', '--expected-revision', '8', '--json',
      ], settingsCommandDeps(execute));

      expect(execute.mock.calls).toEqual([
        ['plugins.settings.list',
          { pluginId: 'acme.settings', scope: { kind: 'account' }, target: { kind: 'account' } },
          { surface: 'cli', defaultSessionId: null, actionRequestId: expect.any(String) }],
        ['plugins.settings.get', {
            pluginId: 'acme.settings', scope: { kind: 'account' }, target: { kind: 'account' }, localId: 'theme',
          }, { surface: 'cli', defaultSessionId: null, actionRequestId: expect.any(String) }],
        ['plugins.settings.reset', {
            pluginId: 'acme.settings', scope: { kind: 'account' }, target: { kind: 'account' }, localId: 'theme', expectedRevision: '8',
          }, { surface: 'cli', defaultSessionId: null, actionRequestId: expect.any(String) }],
      ]);
    } finally {
      output.restore();
    }
  });

  it('routes a daemon-custodied secret through one exact target without assigning it a Settings scope', async () => {
    const execute = vi.fn(async () => ({
      ok: true,
      result: {
        ok: true,
        kind: 'plugins.settings.secret.status',
        data: {
          localId: 'daemon-token',
          custody: 'daemon',
          target: { kind: 'daemon', serverIdentityId: 'srv_settings_1', machineId: 'machine-1' },
          state: 'missing',
          revision: 'daemon-secret-r1:missing',
        },
      },
    }));
    const resolvePluginInvocationLogTarget = vi.fn(async () => ({
      kind: 'selected' as const,
      target: { serverIdentityId: 'srv_settings_1', machineId: 'machine-1' },
    }));
    const output = captureConsoleText();
    try {
      await handlePluginsCommand([
        'settings', 'secret', 'status', 'acme.settings', 'daemon-token', '--machine', 'machine-1', '--json',
      ], {
        ...settingsCommandDeps(execute),
        resolvePluginInvocationLogTarget,
      } as never);

      expect(execute).toHaveBeenCalledWith(
        'plugins.settings.secret.status',
        {
          pluginId: 'acme.settings',
          localId: 'daemon-token',
          secretDaemonTarget: { kind: 'daemon', serverIdentityId: 'srv_settings_1', machineId: 'machine-1' },
        },
        { surface: 'cli', defaultSessionId: null, actionRequestId: expect.any(String) },
      );
    } finally {
      output.restore();
    }
  });

  it('rejects raw secret material and exits silently when its invocation is cancelled', async () => {
    const execute = vi.fn();
    const output = captureConsoleText();
    try {
      await handlePluginsCommand([
        'settings', 'secret', 'status', 'acme.settings', 'token', '--value', '"raw"', '--json',
      ], settingsCommandDeps(execute));
      expect(execute).not.toHaveBeenCalled();
      expect(JSON.parse(output.text())).toMatchObject({
        ok: false,
        kind: 'plugins.settings.secret.status',
        error: { code: 'invalid_arguments' },
      });

      const controller = new AbortController();
      controller.abort(new Error('cancelled'));
      await handlePluginsCommand([
        'settings', 'list', 'acme.settings', '--scope', 'account', '--json',
      ], settingsCommandDeps(execute), { signal: controller.signal });
      expect(execute).not.toHaveBeenCalled();
    } finally {
      output.restore();
    }
  });

  it('reports parser failures as typed Settings errors before authentication or execution', async () => {
    const output = captureConsoleText();
    try {
      await handlePluginsCommand([
        'settings', 'list', 'acme.settings', '--scope', 'account', '--bogus', '--json',
      ]);

      expect(actionExecution.readCredentials).not.toHaveBeenCalled();
      expect(actionExecution.execute).not.toHaveBeenCalled();
      expect(JSON.parse(output.text())).toMatchObject({
        ok: false,
        kind: 'plugins.settings.list',
        error: { code: 'invalid_arguments' },
      });

      output.lines.length = 0;
      await handlePluginsCommand([
        'settings', 'set', 'acme.settings', 'theme', '--scope', 'account', '--value', 'not-json', '--json',
      ]);
      expect(JSON.parse(output.text())).toMatchObject({
        ok: false,
        kind: 'plugins.settings.set',
        error: { code: 'invalid_arguments' },
      });
    } finally {
      output.restore();
    }
  });

  describe('compiled Action field semantics after target resolution', () => {
    it('parses ordinary Settings fields through the shared compiled field parser after resolving the exact daemon target', async () => {
      const execute = vi.fn(async () => ({
        ok: true,
        result: {
          ok: true,
          kind: 'plugins.settings.set',
          data: {
            scope: { kind: 'daemon' },
            target: { kind: 'daemon', serverIdentityId: 'srv_settings_1', machineId: 'machine-1' },
            localId: 'theme',
            revision: '8',
            application: { kind: 'live' },
          },
        },
      }));
      const resolvePluginInvocationLogTarget = vi.fn(async () => ({
        kind: 'selected' as const,
        target: { serverIdentityId: 'srv_settings_1', machineId: 'machine-1' },
      }));
      const output = captureConsoleText();
      try {
        await handlePluginsCommand([
          'settings', 'set', 'acme.settings', 'theme',
          '--scope', 'daemon', '--machine', 'machine-1',
          '--value', '"dark"', '--expected-revision=7', '--json',
        ], {
          ...settingsCommandDeps(execute),
          resolvePluginInvocationLogTarget,
        } as never);

        expect(resolvePluginInvocationLogTarget).toHaveBeenCalledWith({ requestedMachineId: 'machine-1' });
        expect(execute).toHaveBeenCalledWith(
          'plugins.settings.set',
          {
            pluginId: 'acme.settings',
            scope: { kind: 'daemon' },
            target: { kind: 'daemon', serverIdentityId: 'srv_settings_1', machineId: 'machine-1' },
            localId: 'theme',
            value: 'dark',
            expectedRevision: '7',
          },
          { surface: 'cli', defaultSessionId: null, actionRequestId: expect.any(String) },
        );
        expect(JSON.parse(output.text())).toMatchObject({ ok: true, kind: 'plugins.settings.set' });
      } finally {
        output.restore();
      }
    });

    it('parses secret bind fields through the same compiled parser without inventing a target', async () => {
      const execute = vi.fn(async () => ({
        ok: true,
        result: {
          ok: true,
          kind: 'plugins.settings.secret.bind',
          data: {
            localId: 'daemon-token',
            custody: 'account',
            target: { kind: 'account' },
            revision: '9',
            application: { kind: 'live' },
          },
        },
      }));
      const output = captureConsoleText();
      try {
        await handlePluginsCommand([
          'settings', 'secret', 'bind', 'acme.settings', 'daemon-token',
          '--saved-secret-id=saved-1', '--expected-revision', '5', '--json',
        ], settingsCommandDeps(execute));

        expect(execute).toHaveBeenCalledWith(
          'plugins.settings.secret.bind',
          { pluginId: 'acme.settings', localId: 'daemon-token', savedSecretId: 'saved-1', expectedRevision: '5' },
          { surface: 'cli', defaultSessionId: null, actionRequestId: expect.any(String) },
        );
      } finally {
        output.restore();
      }
    });

    it('rejects one Action field supplied by both a positional and its compiled flag', async () => {
      const execute = vi.fn();
      const output = captureConsoleText();
      try {
        await handlePluginsCommand([
          'settings', 'get', 'acme.settings', 'theme', '--scope', 'account', '--local-id', 'other', '--json',
        ], settingsCommandDeps(execute));

        expect(actionExecution.readCredentials).not.toHaveBeenCalled();
        expect(execute).not.toHaveBeenCalled();
        const envelope = JSON.parse(output.text());
        expect(envelope).toMatchObject({
          ok: false,
          kind: 'plugins.settings.get',
          error: { code: 'invalid_arguments' },
        });
        expect(String(envelope.error.message)).toContain('localId');
      } finally {
        output.restore();
      }
    });

    it('treats tokens after -- as literal positionals while target selection stays flag-owned', async () => {
      const execute = vi.fn(async () => ({
        ok: true,
        result: {
          ok: true,
          kind: 'plugins.settings.secret.status',
          data: {
            localId: 'token',
            custody: 'account',
            target: { kind: 'account' },
            state: 'missing',
            revision: 'r1:missing',
          },
        },
      }));
      const resolvePluginInvocationLogTarget = vi.fn();
      const output = captureConsoleText();
      try {
        await handlePluginsCommand([
          'settings', 'secret', 'status', '--json', '--', 'acme.settings', 'token',
        ], {
          ...settingsCommandDeps(execute),
          resolvePluginInvocationLogTarget,
        } as never);

        expect(resolvePluginInvocationLogTarget).not.toHaveBeenCalled();
        expect(execute).toHaveBeenCalledWith(
          'plugins.settings.secret.status',
          { pluginId: 'acme.settings', localId: 'token' },
          { surface: 'cli', defaultSessionId: null, actionRequestId: expect.any(String) },
        );
      } finally {
        output.restore();
      }
    });

    it('validates mutation requirements through the canonical Action schema before authentication', async () => {
      const execute = vi.fn();
      const output = captureConsoleText();
      try {
        await handlePluginsCommand([
          'settings', 'set', 'acme.settings', 'theme', '--scope', 'account', '--json',
        ], settingsCommandDeps(execute));

        expect(execute).not.toHaveBeenCalled();
        expect(JSON.parse(output.text())).toMatchObject({
          ok: false,
          kind: 'plugins.settings.set',
          error: { code: 'invalid_arguments' },
        });

        output.lines.length = 0;
        await handlePluginsCommand([
          'settings', 'secret', 'bind', 'acme.settings', 'daemon-token', '--json',
        ], settingsCommandDeps(execute));
        expect(JSON.parse(output.text())).toMatchObject({
          ok: false,
          kind: 'plugins.settings.secret.bind',
          error: { code: 'invalid_arguments' },
        });
      } finally {
        output.restore();
      }
    });
  });
});
