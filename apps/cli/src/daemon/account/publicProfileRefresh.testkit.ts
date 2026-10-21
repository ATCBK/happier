import { DEFAULT_PUBLIC_PROFILE_POLICY_V1 } from '@happier-dev/protocol/account/publicProfile';
import { DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1, PublicProfileOwnerReadV1Schema } from '@happier-dev/protocol/account/publicProfilePublication';
import { normalizeUsageQuery, resolveUsageQueryPeriod } from '@happier-dev/protocol/inputs/usageQuery';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { ActionsSettingsV1Schema, isActionEnabledByActionsSettings } from '@happier-dev/protocol/actions/actionSettings';
import axios, { type AxiosRequestConfig } from 'axios';
import fastify from 'fastify';
import { expect, vi } from 'vitest';

import { createAccountServerActionDeps } from '@/api/accountServerActionDeps';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createDeferred } from '@/testkit/async/deferred';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createNativePublicProfileRefreshActions } from './nativePublicProfileRefreshActions';

/** Canonical-schema Account HTTP fixture; no eligible Usage population is invented. */
export function createPublicProfileRefreshOwner(computedAtMs: number | null) {
  const query = normalizeUsageQuery({ period: { relative: '90days' } });
  return PublicProfileOwnerReadV1Schema.parse({ kind: 'ready', context: {
    handle: 'ada', identity: { name: 'Ada' }, service: { displayName: 'Home', publicBaseUrl: 'https://home.test' },
    urls: { page: 'https://home.test/@ada', json: 'https://home.test/@ada/json', badgeBase: 'https://home.test/@ada/badge',
      card: 'https://home.test/@ada/card.svg', og: 'https://home.test/@ada/og.png', report: 'mailto:operator@home.test' },
  }, record: { state: 'published', policy: DEFAULT_PUBLIC_PROFILE_POLICY_V1, metadata: {}, projectSelections: [], query,
    snapshot: computedAtMs === null ? null : { v: 1, computedAtMs,
      period: { ...resolveUsageQueryPeriod(query, computedAtMs), timeZoneOffsetMinutes: query.timeZoneOffsetMinutes },
      coverage: { status: 'unknown', method: 'unknown' }, fieldCoverage: {}, facts: {} },
    layout: { v: 1, items: [] }, appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1,
    updatedAtMs: 1, publishedAtMs: 1, restriction: null },
  });
}

/** Real native adapter, shared Action executor and captured Account HTTP binding.
 * Only the remote HTTP peer and clock are substituted; no snapshot producer exists
 * in this binding, so the shared preparer's refusal remains observable.
 */
export async function createNativePublicProfileRefreshFixture(options: {
  computedAtMs?: number | null;
  settings?: unknown;
} = {}) {
  const app = fastify();
  const origin = 'http://profile-home.test';
  let owner = createPublicProfileRefreshOwner(options.computedAtMs === undefined
    ? Date.now() - 24 * 60 * 60 * 1_000 : options.computedAtMs);
  let settings = ActionsSettingsV1Schema.parse(options.settings ?? {
    v: 1, approvalWaivedSurfaces: { 'account.public_profile.refresh': ['cli'] },
  });
  let current = true;
  const requests: Array<{ method: string; path: string }> = [];
  const releases = new Set<() => void>();
  let pendingRead: { accepted(): void; released: Promise<void> } | undefined;
  app.addHook('onRequest', async request => {
    expect(request.headers.authorization).toBe('Bearer captured');
    requests.push({ method: request.method, path: request.url });
  });
  app.get('/v1/account/public-profile', async () => {
    const pending = pendingRead;
    pendingRead = undefined;
    if (pending) {
      pending.accepted();
      await pending.released;
    }
    return owner;
  });
  await app.ready();
  const restoreHttp = installAxiosFastifyAdapter({ app, origin });
  const request = axios.request.bind(axios);
  let requestSignal: AxiosRequestConfig['signal'];
  // Observe the genuine HTTP boundary without replacing the Account/Action logic.
  const requestSpy = vi.spyOn(axios, 'request').mockImplementation(config => {
    requestSignal = config.signal;
    return request(config);
  });
  const deps = createAccountServerActionDeps({ token: 'captured', serverId: 'home',
    serverHttpBaseUrl: origin, isCredentialCurrent: async () => current });
  const executor = createActionExecutor({
    ...createUnavailableActionTransportDeps(), ...deps,
    isActionEnabled: (id, context) => isActionEnabledByActionsSettings(id, settings, context),
    isActionApprovalRequired: (id, context, input) =>
      isApprovalRequiredByActionsSettings(id, settings, context, undefined, undefined, input),
  });
  const actions = createNativePublicProfileRefreshActions({ executor, serverId: 'home', getActionsSettings: () => settings });
  const releaseReads = () => { for (const release of releases) release(); };
  return {
    actions, requests, isCurrent: async () => current,
    getRequestSignal: () => requestSignal,
    retire: () => { current = false; },
    setComputedAt: (value: number | null) => { owner = createPublicProfileRefreshOwner(value); },
    pauseProfile: () => {
      if (owner.kind !== 'ready' || !owner.record) throw new Error('Expected published remote fixture');
      owner = PublicProfileOwnerReadV1Schema.parse({ ...owner, record: { ...owner.record, state: 'paused' } });
    },
    setSettings: (value: unknown) => { settings = ActionsSettingsV1Schema.parse(value); },
    holdNextRead: () => {
      const accepted = createDeferred();
      const released = createDeferred();
      const release = () => { releases.delete(release); released.resolve(); };
      releases.add(release);
      pendingRead = { accepted: () => accepted.resolve(), released: released.promise };
      return { accepted: accepted.promise, release };
    },
    releaseReads,
    dispose: async () => {
      releaseReads();
      requestSpy.mockRestore();
      restoreHttp();
      await app.close();
    },
  };
}
