import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, flushHookEffects, renderScreen } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import {
  PromptBundleArtifactHeaderV1Schema,
  PromptBundleBodyV1Schema,
} from '@happier-dev/protocol/prompts/library/promptBundleSchemas';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import {
  ARTIFACT_PLAIN_DATA_KEY_MARKER,
  encodePlainArtifactStoredContent,
} from '@happier-dev/protocol/storage/artifactStoredContent';

const navigation = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }));

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock({ router: navigation, navigation: { canGoBack: () => false } }).module;
});
vi.mock('@/modal', async () => {
  const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
  return createModalModuleMock({ spies: {} }).module;
});

let fixture: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>> | undefined;
beforeEach(async () => {
  await loadSyncSingletonForTests();
});
afterEach(async () => {
  const { resetPromptLibraryCatalogEngineForTests } = await import('@/sync/engine/settings/promptLibraryCatalogEngine');
  const { resetPromptLibraryCatalogSnapshotsForTests } = await import('@/sync/store/settings/promptLibraryCatalogSnapshot');
  resetPromptLibraryCatalogEngineForTests();
  resetPromptLibraryCatalogSnapshotsForTests();
  await fixture?.dispose();
  fixture = undefined;
});

describe('SkillDetailScreen when the library cannot be read', () => {
  it('leads with the Couldn’t load banner instead of an empty page, and Try again brings the skill back', async () => {
    const { SkillDetailScreen } = await import('./SkillDetailScreen');
    const { storage } = await import('@/sync/domains/state/storage');
    const catalog = createPromptLibraryCatalogBoundary();
    let failing = true;
    fixture = await createPlainArtifactHomeFixture('https://skill-detail-load-failure.test', {
      serverFeatures: createRootLayoutFeaturesResponse(),
      handleRequest: async (path, init) => {
        if (failing && path.startsWith('/v1/artifacts')) return Response.json({ error: 'unavailable' }, { status: 500 });
        if (path === '/v2/account/settings/history') return Response.json({ snapshots: [] });
        return catalog.handle(path, init);
      },
    });
    const skillMd = '---\nname: release-notes\ndescription: Draft release notes.\n---\n\n# Release notes\n';
    const header = PromptBundleArtifactHeaderV1Schema.parse({ v: 1, kind: 'prompt_bundle.v2', title: 'release-notes', bundleSchemaId: 'skills.skill_md_v1' });
    const body = PromptBundleBodyV1Schema.parse({ v: 1, createdAtMs: 1, updatedAtMs: 1, entries: [
      { path: 'SKILL.md', contentKind: 'utf8', contentBase64: encodeBase64(new TextEncoder().encode(skillMd)) },
    ] });
    failing = false;
    const seeded = await fixture.boundary.handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({
      id: 'release-notes', header: encodePlainArtifactStoredContent(header),
      body: encodePlainArtifactStoredContent({ body: JSON.stringify(body) }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
    }) });
    expect(seeded?.status).toBe(200);
    failing = true;
    storage.setState({ isDataReady: true, artifactsLoaded: true });

    const screen = await renderScreen(<SkillDetailScreen skillId="release-notes" />);
    await vi.waitFor(async () => {
      await flushHookEffects();
      expect(screen.findByTestId('skill.detail.banner')).toBeTruthy();
    }, { timeout: 20_000 });
    expect(screen.findByTestId('skill.detail.instructions')).toBeNull();
    expect(screen.findByTestId('skill.detail.leave')).toBeNull();

    failing = false;
    await act(async () => { await screen.pressByTestIdAsync('skill.detail.banner.action'); });
    await vi.waitFor(async () => {
      await flushHookEffects();
      expect(screen.findByTestId('skill.detail.instructions')).toBeTruthy();
    }, { timeout: 20_000 });
    expect(screen.findByTestId('skill.detail.banner')).toBeNull();
  });
});
