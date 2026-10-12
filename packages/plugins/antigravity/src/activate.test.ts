import { describe, expect, it } from 'vitest';

import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';

import { activate } from './activate.js';
import { antigravityExternalSessionsContribution } from './agent/cliPrint/externalSessions.js';
import { antigravityExternalSessionObservationContribution } from './agent/cliPrint/observation.js';
import { PLUGIN_MANIFEST } from './manifest.js';

describe('Antigravity plugin activation', () => {
  it('reexports the activation compiled by its canonical public plugin definition', async () => {
    expect(Object.keys(PLUGIN_MANIFEST.contributes).sort()).toEqual([
      'agents',
      'connectedAccountDescriptors',
      'managedDependencies',
      'systemTools',
    ]);
    expect(await import('./manifest.js')).toEqual(expect.objectContaining({
      ANTIGRAVITY_PLUGIN: expect.objectContaining({ manifest: PLUGIN_MANIFEST, activate }),
    }));
  });

  it('registers provider leaves with the host ACP session runtime', async () => {
    const fixture = await createPluginTestkit({
      manifest: PLUGIN_MANIFEST,
      module: { activate },
    });
    try {
      expect(fixture.registrations()).toContainEqual({
        family: 'agents',
        localId: 'antigravity',
      });
      const registration = fixture.registration('agents', 'antigravity');

      // The declarative ACP runtime is the sole session owner: no plugin-side session
      // factory, runner-factory locator, spawn hook, or preflight control may exist.
      expect(registration?.factory).toBeUndefined();
      expect(registration?.sessionRunnerFactory).toBeUndefined();
      expect(registration?.daemonSpawnHooks).toBeUndefined();
      expect(registration?.preflightSessionControls).toBeUndefined();
      expect(registration?.cliSessionCommand).toBeUndefined();
      expect(fixture.registration('hooks', 'resolve-prerequisites')).toBeUndefined();

      expect(registration?.terminal).toEqual({ resolveLaunch: expect.any(Function) });
      expect(Object.keys(registration?.externalSessions ?? {}).sort()).toEqual([
        'listCandidates',
        'pageTranscript',
        'readAfterTranscript',
        'resolveLinkIdentity',
        'resolveLinkedIdentity',
        'resolveSource',
      ]);
      expect(Object.keys(
        registration?.externalSessionObservation ?? {},
      ).sort()).toEqual([
        'describeResource',
        'observeResource',
        'reconcileResource',
      ]);
      expect(registration?.externalSessionHooks).toBeUndefined();
      expect(registration?.externalSessionTakeover).toBeUndefined();

      const cancelled = new AbortController();
      cancelled.abort();
      const cancelledRequest = {
        signal: cancelled.signal,
        deadlineAtMs: Date.now() + 30_000,
        maxSerializedBytes: 64 * 1024,
        source: {},
      } as never;
      expect(registration?.externalSessions?.resolveSource(cancelledRequest)).toEqual(
        antigravityExternalSessionsContribution.resolveSource(cancelledRequest),
      );
      expect(registration?.externalSessions).not.toBe(
        antigravityExternalSessionsContribution,
      );
      expect(registration?.externalSessionObservation).not.toBe(
        antigravityExternalSessionObservationContribution,
      );
    } finally {
      await fixture.dispose();
    }
  });

  it('launches the interactive Antigravity CLI as a surface separate from ACP sessions', async () => {
    const fixture = await createPluginTestkit({
      manifest: PLUGIN_MANIFEST,
      module: { activate },
    });
    try {
      const terminal = fixture.registration('agents', 'antigravity')?.terminal;
      if (!terminal) throw new Error('Expected the Antigravity terminal surface.');

      const launch = terminal.resolveLaunch({
        metadata: {
          runtimeDescriptorV1: {
            v: 1,
            agentId: 'antigravity',
            agent: {
              // A host ACP session id must never become an `agy --conversation` argument.
              providerSessionId: 'acp-session-1',
              agentExtra: {
                owner: 'antigravity',
                schemaId: 'antigravity.agentRuntimeDescriptorExtra',
                v: 1,
                runtimeHandle: { agyConversationId: 'agy-conversation-1' },
              },
            },
          },
        },
        modelSelection: { modelId: 'Gemini 3.5 Flash (High)' },
      } as never);

      expect(launch.argv).toEqual([
        '--conversation',
        'agy-conversation-1',
        '--model',
        'Gemini 3.5 Flash (High)',
      ]);
    } finally {
      await fixture.dispose();
    }
  });
});
