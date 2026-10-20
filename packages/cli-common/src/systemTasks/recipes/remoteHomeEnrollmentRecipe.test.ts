import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

import { parseHomeTargetInput } from '../../homeTarget/homeTarget.js';
import type { HappierJsonExecutor } from '../executors/happierJsonExecutor.js';

import { runRemoteHomeEnrollmentRecipe } from './remoteHomeEnrollmentRecipe.js';
import { createOpenSshHappierJsonExecutor } from '../executors/openSshHappierJsonExecutor.js';

const descriptor = {
  v: 1 as const,
  homeServerIdentityId: 'srv_home_remote_1',
  canonicalServerUrl: 'http://127.0.0.1:4123',
  revision: 1,
  endpoints: [{
    kind: 'iroh' as const,
    endpointId: 'a'.repeat(64),
  }],
};
const PUBLIC_KEY = Buffer.alloc(32, 1).toString('base64');
const PAIRING_SECRET = Buffer.alloc(32, 2).toString('base64url');
const pairing = { secretB64Url: PAIRING_SECRET, createdAtMs: Date.now(), expiresAtMs: Date.now() + 15 * 60_000 };

// Ordinary stdout from cli-v0.2.16 (b8d1c449c46ab4dfa8637db36b66f643d149e66d),
// apps/cli/src/cli/commands/auth/request.ts#handleAuthRequest; values redacted.
const olderAuthRequest: Record<string, unknown> = JSON.parse(readFileSync(
  new URL('./fixtures/authRequest.cli-v0.2.16.json', import.meta.url), 'utf8',
));

function createExecutor(params: Readonly<{
  lines: readonly Record<string, unknown>[];
  seen: Array<Readonly<{ args: readonly string[]; input?: string; includeStdoutInError?: boolean }>>;
}>): HappierJsonExecutor {
  return {
    runHappierText: async (args, opts) => {
      params.seen.push({
        args,
        ...(opts?.input ? { input: opts.input } : {}),
        ...(typeof opts?.includeStdoutInError === 'boolean'
          ? { includeStdoutInError: opts.includeStdoutInError }
          : {}),
      });
      const stdout = `${params.lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
      for (const chunk of [stdout.slice(0, 37), stdout.slice(37)]) {
        opts?.onStdoutChunk?.(chunk);
        await Promise.resolve();
      }
      return { status: 0, stdout, stderr: '' };
    },
    runHappierJson: async () => {
      throw new Error('not used');
    },
  };
}

describe('runRemoteHomeEnrollmentRecipe', () => {
  it('accepts four-minute consent within the recipe budget and gives wait only the remainder', async () => {
    vi.useFakeTimers();
    try {
      const request = { kind: 'remote_home_enrollment_pairing_request', protocolVersion: 1,
        publicKey: PUBLIC_KEY, homeServerIdentityId: descriptor.homeServerIdentityId,
        pairing: { ...pairing, createdAtMs: Date.now(), expiresAtMs: Date.now() + 15 * 60_000 },
        supportsTokenOnly: true, pairingRequirement: 'v3', remoteProfileId: 'remote-home-profile' };
      const budgets: number[] = [];
      const completed = runRemoteHomeEnrollmentRecipe({ processIO: 'buffered',
        homeTargetInput: { kind: 'descriptor', descriptor, authority: 'trusted_enrollment' },
        executor: { runHappierJson: async () => { throw new Error('not used'); },
          runHappierText: async (args, options) => {
            budgets.push(options!.timeoutMs!);
            return { status: 0, stderr: '', stdout: JSON.stringify(args[1] === 'request' ? request : {
              kind: 'remote_home_enrollment_result', protocolVersion: 1, success: true,
              homeServerIdentityId: descriptor.homeServerIdentityId, machineId: 'joined',
              encryptionType: 'tokenOnly', pairingAuthentication: 'v3', remoteProfileId: 'remote-home-profile',
            }) };
          } },
        approvePairingRequest: async () => { await new Promise(resolve => setTimeout(resolve, 4 * 60_000)); },
        timeoutMs: 10 * 60_000,
      });
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      await expect(completed).resolves.toMatchObject({ machineId: 'joined' });
      expect(budgets).toEqual([10 * 60_000, 6 * 60_000]);
    } finally { vi.useRealTimers(); }
  });

  it.each(['request', 'wait'] as const)('retains the typed %s failure and exit phase without subprocess secrets', async phase => {
    const request = { kind: 'remote_home_enrollment_pairing_request', protocolVersion: 1,
      publicKey: PUBLIC_KEY, homeServerIdentityId: descriptor.homeServerIdentityId,
      pairing,
      supportsTokenOnly: true, pairingRequirement: 'v3', remoteProfileId: 'remote-home-profile' };
    const failure = await runRemoteHomeEnrollmentRecipe({ processIO: 'buffered',
      homeTargetInput: { kind: 'descriptor', descriptor, authority: 'trusted_enrollment' },
      executor: { runHappierJson: async () => { throw new Error('not used'); },
        runHappierText: async args => args[1] !== phase
          ? { status: 0, stdout: JSON.stringify(request), stderr: '' }
          : { status: 1, stdout: JSON.stringify({ v: 1, ok: false, kind: `auth_${phase}`,
            error: { code: 'ERR_BAD_REQUEST', category: 'http_error', status: 409, token: 'private-token', message: 'private-message' } }),
            stderr: 'private-stderr' } },
      approvePairingRequest: async () => {}, timeoutMs: 5_000,
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'remote_command_failed',
      message: `Remote Home enrollment failed during auth ${phase} (exit 1; code ERR_BAD_REQUEST; category http_error; HTTP 409).` });
    expect(JSON.stringify(failure)).not.toMatch(/private-token|private-message|private-stderr/);
  });

  it.each(['older-text', 'wrong-kind'] as const)('retains only phase and exit for an untrusted failure envelope (%s)', async variant => {
    const failure = await runRemoteHomeEnrollmentRecipe({ processIO: 'buffered',
      homeTargetInput: { kind: 'descriptor', descriptor, authority: 'trusted_enrollment' },
      executor: { runHappierJson: async () => { throw new Error('not used'); },
        runHappierText: async () => ({ status: 1, stderr: 'private-stderr',
          stdout: variant === 'older-text' ? 'private-stdout' : JSON.stringify({ v: 1, ok: false,
            kind: 'auth_wait', error: { code: 'UNTRUSTED_CODE', category: 'http_error', status: 409 } }) }) },
      approvePairingRequest: async () => {}, timeoutMs: 5_000,
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'remote_command_failed',
      message: 'Remote Home enrollment failed during auth request (exit 1).' });
    expect(JSON.stringify(failure)).not.toMatch(/private-|UNTRUSTED_CODE|http_error|409/);
  });

  it.each([
    '',
    'private-malformed-output',
    'private-warning\n' + JSON.stringify({ v: 1, ok: false, kind: 'auth_wait', error: { code: 'AUTH_WAIT_FAILED' } }),
    JSON.stringify({ v: 1, ok: false, kind: 'auth_wait', error: { code: 'AUTH_WAIT_FAILED' } }) + '\n{}',
  ])('classifies a wait process failure with absent or invalid diagnostics (%s)', async stdout => {
    const request = { kind: 'remote_home_enrollment_pairing_request', protocolVersion: 1,
      publicKey: PUBLIC_KEY, homeServerIdentityId: descriptor.homeServerIdentityId,
      pairing, supportsTokenOnly: true, pairingRequirement: 'v3', remoteProfileId: 'remote-home-profile' };
    const failure = await runRemoteHomeEnrollmentRecipe({ processIO: 'buffered',
      homeTargetInput: { kind: 'descriptor', descriptor, authority: 'trusted_enrollment' },
      executor: { runHappierJson: async () => { throw new Error('not used'); },
        runHappierText: async args => args[1] === 'request'
          ? { status: 0, stdout: JSON.stringify(request), stderr: '' }
          : { status: 1, stdout, stderr: 'private-native-error' } },
      approvePairingRequest: async () => {}, timeoutMs: 5_000,
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'remote_command_failed',
      message: `Remote Home enrollment failed during auth wait (exit 1; code AUTH_WAIT_PROCESS_FAILED; diagnostic ${stdout ? 'invalid; check parse' : 'absent'}).` });
    expect(String(failure)).not.toMatch(/private-native-error|private-malformed-output|private-warning/);
  });

  it.each([
    { response: { v: 2, ok: false, kind: 'auth_wait', error: { code: 'PRIVATE_CODE' } }, check: 'v' },
    { response: { v: 1, ok: true, kind: 'auth_wait', error: { code: 'PRIVATE_CODE' } }, check: 'ok' },
    { response: { v: 1, ok: false, kind: 'auth_request', error: { code: 'PRIVATE_CODE' } }, check: 'kind' },
    { response: { v: 1, ok: false, kind: 'auth_wait', error: { code: 'private/secret' } }, check: 'code' },
    { response: { v: 1, ok: false, kind: 'auth_wait' }, check: 'code' },
    { response: null, check: 'v' },
  ])('identifies the failed diagnostic check without copying rejected fields ($check)', async ({ response, check }) => {
    const request = { kind: 'remote_home_enrollment_pairing_request', protocolVersion: 1,
      publicKey: PUBLIC_KEY, homeServerIdentityId: descriptor.homeServerIdentityId,
      pairing, supportsTokenOnly: true, pairingRequirement: 'v3', remoteProfileId: 'remote-home-profile' };
    const failure = await runRemoteHomeEnrollmentRecipe({ processIO: 'buffered',
      homeTargetInput: { kind: 'descriptor', descriptor, authority: 'trusted_enrollment' },
      executor: { runHappierJson: async () => { throw new Error('not used'); },
        runHappierText: async args => args[1] === 'request'
          ? { status: 0, stdout: JSON.stringify(request), stderr: '' }
          : { status: 1, stdout: JSON.stringify(response), stderr: 'private-native-error' } },
      approvePairingRequest: async () => {}, timeoutMs: 5_000,
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'remote_command_failed',
      message: `Remote Home enrollment failed during auth wait (exit 1; code AUTH_WAIT_PROCESS_FAILED; diagnostic invalid; check ${check}).` });
    expect(String(failure)).not.toMatch(/PRIVATE_CODE|private\/secret|private-native-error/);
  });

  it('reports an unfamiliar uppercase diagnostic code as data', async () => {
    const request = { kind: 'remote_home_enrollment_pairing_request', protocolVersion: 1,
      publicKey: PUBLIC_KEY, homeServerIdentityId: descriptor.homeServerIdentityId,
      pairing, supportsTokenOnly: true, pairingRequirement: 'v3', remoteProfileId: 'remote-home-profile' };
    const failure = await runRemoteHomeEnrollmentRecipe({ processIO: 'buffered',
      homeTargetInput: { kind: 'descriptor', descriptor, authority: 'trusted_enrollment' },
      executor: { runHappierJson: async () => { throw new Error('not used'); },
        runHappierText: async args => args[1] === 'request'
          ? { status: 0, stdout: JSON.stringify(request), stderr: '' }
          : { status: 1, stdout: JSON.stringify({ v: 1, ok: false, kind: 'auth_wait',
            error: { code: 'AUTH_FUTURE_POST_CLAIM_FAILURE', message: 'private-message' } }), stderr: '' } },
      approvePairingRequest: async () => {}, timeoutMs: 5_000,
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'remote_command_failed',
      message: 'Remote Home enrollment failed during auth wait (exit 1; code AUTH_FUTURE_POST_CLAIM_FAILURE).' });
    expect(String(failure)).not.toContain('private-message');
  });

  it('requires a remote CLI update for released ordinary auth request stdout without disclosing it', async () => {
    const seen: Array<Readonly<{ args: readonly string[]; input?: string; includeStdoutInError?: boolean }>> = [];
    const approvePairingRequest = vi.fn(async () => {});
    const error = await runRemoteHomeEnrollmentRecipe({
      executor: createExecutor({ seen, lines: [olderAuthRequest] }), processIO: 'buffered',
      homeTargetInput: { kind: 'descriptor', descriptor, authority: 'trusted_enrollment' },
      approvePairingRequest, timeoutMs: 5_000,
    }).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: 'remote_cli_update_required' });
    expect(approvePairingRequest).not.toHaveBeenCalled();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.includeStdoutInError).toBe(false);
    for (const secret of ['redacted-claim-secret', 'redacted-pairing-secret', '/redacted/auth/pending']) {
      expect(String(error)).not.toContain(secret);
      expect(JSON.stringify(error)).not.toContain(secret);
    }
  });

  it.each(['released', 'wrong-status', 'wrong-stderr', 'malformed'] as const)(
    'classifies only the released unsupported streaming command through the SSH executor (%s)', async variant => {
      const released: { status: number; stdout: string; stderr: string } = JSON.parse(readFileSync(
        new URL('./fixtures/authEnrollRemote.cli-v0.2.16.json', import.meta.url), 'utf8',
      ));
      const response = { ...released,
        ...(variant === 'wrong-status' ? { status: 0 } : {}),
        ...(variant === 'wrong-stderr' ? { stderr: 'Authentication failed\n' } : {}),
        ...(variant === 'malformed' ? { stdout: 'not JSON\n' } : {}),
      };
      const approvePairingRequest = vi.fn(async () => {});
      const runRemoteText = vi.fn(async (params: Parameters<Parameters<typeof createOpenSshHappierJsonExecutor>[0]['runRemoteText']>[0]) => {
        expect(params.remoteCommand).toContain("'enroll-remote' '--json-lines' '--home-target-stdin'");
        expect(params.includeStdoutInError).toBe(false);
        for (const chunk of [response.stdout.slice(0, 37), response.stdout.slice(37)]) params.onStdoutChunk?.(chunk);
        return response;
      });
      const error = await runRemoteHomeEnrollmentRecipe({
        executor: createOpenSshHappierJsonExecutor({ ssh: { target: 'guest.example.test', auth: 'agent' },
          auth: { mode: 'agent' }, knownHostsMode: 'system', runRemoteText }),
        homeTargetInput: { kind: 'descriptor', descriptor, authority: 'trusted_enrollment' },
        approvePairingRequest, timeoutMs: 5_000,
      }).catch((error: unknown) => error);
      expect(error).toMatchObject({ code: variant === 'released' ? 'remote_cli_update_required' : 'invalid_cli_response' });
      expect(approvePairingRequest).not.toHaveBeenCalled();
      expect(runRemoteText).toHaveBeenCalledTimes(1);
      expect(String(error)).not.toContain('Authentication management');
      expect(JSON.stringify(error)).not.toContain('Authentication management');
    },
  );

  it.each(['buffered', 'streaming'] as const)('keeps malformed or unrecognized stdout invalid over %s IO', async (processIO) => {
    for (const response of [{}, { ...olderAuthRequest, pairing: null }, { ...olderAuthRequest, kind: 'unknown_event' }]) {
      const approvePairingRequest = vi.fn(async () => {});
      await expect(runRemoteHomeEnrollmentRecipe({
        executor: createExecutor({ seen: [], lines: [response] }), processIO,
        homeTargetInput: { kind: 'descriptor', descriptor, authority: 'trusted_enrollment' },
        approvePairingRequest, timeoutMs: 5_000,
      })).rejects.toMatchObject({ code: 'invalid_cli_response' });
      expect(approvePairingRequest).not.toHaveBeenCalled();
    }
  });

  it('enrolls over buffered exec only, approving between the finite request and wait commands', async () => {
    const seen: Array<Readonly<{ args: readonly string[]; input?: string }>> = [];
    let approved = false;
    const request = { kind: 'remote_home_enrollment_pairing_request', protocolVersion: 1,
      publicKey: PUBLIC_KEY, homeServerIdentityId: descriptor.homeServerIdentityId,
      pairing,
      supportsTokenOnly: true, pairingRequirement: 'v3', remoteProfileId: 'remote-home-profile' };
    const completion = { kind: 'remote_home_enrollment_result', protocolVersion: 1, success: true,
      homeServerIdentityId: descriptor.homeServerIdentityId, machineId: 'remote-machine',
      encryptionType: 'tokenOnly', pairingAuthentication: 'v3', remoteProfileId: 'remote-home-profile' };
    const executor: HappierJsonExecutor = {
      runHappierText: async (args, opts) => {
        seen.push({ args, input: opts?.input });
        // A buffered carrier never invokes onStdoutChunk. The request returns
        // before approval; waiting is a separate invocation of normal auth.
        if (args[1] === 'request') return { status: 0, stdout: JSON.stringify(request), stderr: '' };
        expect(approved).toBe(true);
        expect(args).toEqual(['auth', 'wait', '--json', '--remote-enrollment', '--server', 'remote-home-profile', '--no-persist', '--public-key', PUBLIC_KEY]);
        return { status: 0, stdout: JSON.stringify(completion), stderr: '' };
      },
      runHappierJson: async () => { throw new Error('not used'); },
    };
    const result = await runRemoteHomeEnrollmentRecipe({ executor, processIO: 'buffered',
      homeTargetInput: { kind: 'descriptor', descriptor, authority: 'trusted_enrollment' },
      approvePairingRequest: async () => { approved = true; }, timeoutMs: 5_000 });
    expect(seen[0]!.args).toEqual(['auth', 'request', '--json', '--remote-enrollment', '--home-target-stdin']);
    expect(JSON.parse(seen[0]!.input!)).toEqual(parseHomeTargetInput({ kind: 'descriptor', descriptor, authority: 'trusted_enrollment' }));
    expect(seen[1]!.input).toBeUndefined();
    expect(result.machineId).toBe('remote-machine');
    expect(JSON.stringify(result)).not.toContain(PAIRING_SECRET);
  });

  it('rejects a managed enrollment for another Home before starting the guest process', async () => {
    const seen: Array<Readonly<{ args: readonly string[]; input?: string }>> = [];
    await expect(runRemoteHomeEnrollmentRecipe({
      executor: createExecutor({ seen, lines: [] }),
      homeTargetInput: { kind: 'descriptor', descriptor, authority: 'trusted_enrollment' },
      managedEnrollment: {
        homeId: 'srv_other_home', managedId: 'managed-1', expectedIntentRevision: 1,
        requestId: 'request-1', controller: { machineId: 'controller', installationId: 'installation' },
        resource: { contributionRef: { pluginId: 'happier.machine.lima', localId: 'lima' }, schemaVersion: 1, value: { instance: 'paid-1' } },
      },
      approvePairingRequest: async () => {},
      timeoutMs: 5_000,
    })).rejects.toMatchObject({ code: 'home_identity_mismatch' });
    expect(seen).toEqual([]);
  });

  it('carries managed correlation only in protected guest input', async () => {
    const seen: Array<Readonly<{ args: readonly string[]; input?: string }>> = [];
    const managedEnrollment = {
      homeId: descriptor.homeServerIdentityId, managedId: 'managed-1', expectedIntentRevision: 1,
      requestId: 'request-1', controller: { machineId: 'controller', installationId: 'installation' },
      resource: { contributionRef: { pluginId: 'happier.machine.lima', localId: 'lima' }, schemaVersion: 1, value: { instance: 'paid-1' } },
    };
    await expect(runRemoteHomeEnrollmentRecipe({
      executor: createExecutor({ seen, lines: [] }), managedEnrollment,
      homeTargetInput: { kind: 'descriptor', descriptor, authority: 'trusted_enrollment' },
      approvePairingRequest: async () => {}, timeoutMs: 5_000,
    })).rejects.toMatchObject({ code: 'invalid_cli_response' });
    expect(JSON.parse(seen[0]!.input!)).toEqual({
      homeTarget: parseHomeTargetInput({ kind: 'descriptor', descriptor, authority: 'trusted_enrollment' }), managedEnrollment,
    });
    expect(seen[0]!.args).not.toContain('managed-1');
  });

  it('uses one descriptor-aware remote process and returns only non-secret completion facts', async () => {
    const seen: Array<Readonly<{ args: readonly string[]; input?: string; includeStdoutInError?: boolean }>> = [];
    const approved: Array<Record<string, unknown>> = [];
    const result = await runRemoteHomeEnrollmentRecipe({
      executor: createExecutor({
        seen,
        lines: [
          {
            kind: 'remote_home_enrollment_pairing_request',
            protocolVersion: 1,
            publicKey: PUBLIC_KEY,
            homeServerIdentityId: descriptor.homeServerIdentityId,
            pairing,
            supportsTokenOnly: true,
            pairingRequirement: 'v3',
          },
          {
            kind: 'remote_home_enrollment_result',
            protocolVersion: 1,
            success: true,
            homeServerIdentityId: descriptor.homeServerIdentityId,
            machineId: 'remote-machine',
            encryptionType: 'tokenOnly',
            pairingAuthentication: 'v3',
            remoteProfileId: 'remote-home-profile',
          },
        ],
      }),
      homeTargetInput: { kind: 'descriptor', descriptor, authority: 'trusted_enrollment' },
      approvePairingRequest: async (request) => {
        approved.push(request);
      },
      timeoutMs: 5_000,
    });

    expect(seen).toEqual([{
      args: ['auth', 'enroll-remote', '--json-lines', '--home-target-stdin'],
      input: JSON.stringify(parseHomeTargetInput({
        kind: 'descriptor',
        descriptor,
        authority: 'trusted_enrollment',
      })),
      includeStdoutInError: false,
    }]);
    expect(approved).toHaveLength(1);
    expect(result).toEqual({
      success: true,
      homeServerIdentityId: descriptor.homeServerIdentityId,
      machineId: 'remote-machine',
      encryptionType: 'tokenOnly',
      pairingAuthentication: 'v3',
      remoteProfileId: 'remote-home-profile',
    });
    expect(JSON.stringify(result)).not.toContain(PAIRING_SECRET);
  });

  it('aborts the one remote process when approval fails without disclosing its output', async () => {
    let observedAbort = false;
    const executor: HappierJsonExecutor = {
      runHappierText: async (_args, opts) => {
        opts?.onStdoutChunk?.(`${JSON.stringify({
          kind: 'remote_home_enrollment_pairing_request',
          protocolVersion: 1,
          publicKey: PUBLIC_KEY,
          homeServerIdentityId: descriptor.homeServerIdentityId,
          pairing,
          supportsTokenOnly: true,
          pairingRequirement: 'v3',
        })}\n`);
        await new Promise<void>((_resolve, reject) => {
          opts?.signal?.addEventListener('abort', () => {
            observedAbort = true;
            reject(new Error('command aborted with sensitive stdout'));
          }, { once: true });
        });
        throw new Error('unreachable');
      },
      runHappierJson: async () => {
        throw new Error('not used');
      },
    };

    await expect(runRemoteHomeEnrollmentRecipe({
      executor,
      homeTargetInput: { kind: 'descriptor', descriptor, authority: 'trusted_enrollment' },
      approvePairingRequest: async () => {
        throw new Error('approval rejected');
      },
      timeoutMs: 5_000,
    })).rejects.toThrow('approval rejected');
    expect(observedAbort).toBe(true);
  });

  it('rejects extra protocol events instead of accepting the last plausible result', async () => {
    const seen: Array<Readonly<{ args: readonly string[]; input?: string }>> = [];
    await expect(runRemoteHomeEnrollmentRecipe({
      executor: createExecutor({
        seen,
        lines: [
          {
            kind: 'remote_home_enrollment_pairing_request',
            protocolVersion: 1,
            publicKey: PUBLIC_KEY,
            homeServerIdentityId: descriptor.homeServerIdentityId,
            pairing,
            supportsTokenOnly: true,
            pairingRequirement: 'v3',
          },
          { kind: 'unexpected_event' },
          {
            kind: 'remote_home_enrollment_result',
            protocolVersion: 1,
            success: true,
            homeServerIdentityId: descriptor.homeServerIdentityId,
            machineId: 'remote-machine',
            encryptionType: 'tokenOnly',
            pairingAuthentication: 'v3',
            remoteProfileId: 'remote-home-profile',
          },
        ],
      }),
      homeTargetInput: { kind: 'descriptor', descriptor, authority: 'trusted_enrollment' },
      approvePairingRequest: async () => undefined,
      timeoutMs: 5_000,
    })).rejects.toThrow('invalid event sequence');
  });

  it('rejects a descriptor identity mismatch before requesting local approval', async () => {
    const approvePairingRequest = vi.fn(async () => undefined);
    await expect(runRemoteHomeEnrollmentRecipe({
      executor: createExecutor({
        seen: [],
        lines: [
          {
            kind: 'remote_home_enrollment_pairing_request',
            protocolVersion: 1,
            publicKey: PUBLIC_KEY,
            homeServerIdentityId: 'srv_other_home',
            pairing,
            supportsTokenOnly: true,
            pairingRequirement: 'v3',
          },
          {
            kind: 'remote_home_enrollment_result',
            protocolVersion: 1,
            success: true,
            homeServerIdentityId: 'srv_other_home',
            machineId: 'remote-machine',
            encryptionType: 'tokenOnly',
            pairingAuthentication: 'v3',
            remoteProfileId: 'remote-home-profile',
          },
        ],
      }),
      homeTargetInput: { kind: 'descriptor', descriptor, authority: 'trusted_enrollment' },
      approvePairingRequest,
      timeoutMs: 5_000,
    })).rejects.toMatchObject({ code: 'home_identity_mismatch' });
    expect(approvePairingRequest).not.toHaveBeenCalled();
  });
});
