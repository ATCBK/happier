// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { Button, Tabs, Text, defineUiSurface } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import {
  createPluginTestkit,
  createPluginUiTestkit,
  createSurfaceContextFixture,
  type PluginUiTestkit,
} from '@happier-dev/plugin-sdk/testing';
import {
  describeTriageSourceFailureV1,
  TriageDetailSurfaceInputV1Schema,
} from '@happier-dev/triage-protocol/v1';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { activate } from '../../activate.js';
import { PLUGIN_MANIFEST } from '../../manifest.js';
import {
  GITHUB_CONNECTED_ACCOUNT_PURPOSE,
  GITHUB_PLUGIN_ID,
} from '../../observations/githubProviderContracts.js';
import { encodeGithubTriageConfiguration } from '../../triage/configuration.js';
import { GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1 } from '../../triage/contribution.js';
import {
  GithubChangedFilesInputV1Schema,
  GithubChangedFilesResultV1Schema,
} from '../../triage/detail/contracts.js';
import {
  GITHUB_FIXTURE_REPOSITORY_ID,
  githubChangedFile,
} from '../../triage/__fixtures__/githubResponses.js';
import {
  createStubGithubTransport,
  type StubHttpResponse,
} from '../../triage/testkit/githubTriage.test-support.js';
import { renderSurface } from '../renderSurface.js';
import {
  GITHUB_DETAIL_BOUNDS_V1,
  projectGithubChangedFileRows,
} from '../../triage/detail/projection.js';
import {
  useGithubChangedFileDiff,
  type GithubChangedFileViewV1,
} from './panelReaders.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: PluginUiTestkit[] = [];
const plugins: Array<Awaited<ReturnType<typeof createPluginTestkit>>> = [];
afterEach(async () => {
  for (const surface of mounted.splice(0))
    await act(async () => {
      await surface.dispose();
    });
  for (const plugin of plugins.splice(0)) await plugin.dispose();
});

function launchInput() {
  const source = { pluginId: GITHUB_PLUGIN_ID, localId: 'github-forge' };
  const token = encodeGithubTriageConfiguration({
    v: 1,
    scope: { kind: 'repository', repositoryKey: 'octo-org/example-app' },
  });
  if (token === null) throw new Error('Expected valid GitHub configuration');
  return TriageDetailSurfaceInputV1Schema.parse({
    v: 1,
    panel: 'files',
    instance: {
      v: 1,
      instance: {
        source,
        sourceInstanceId: '9d2a6b1e-6c1a-4b7d-9f31-1d4a6c8b2e70',
      },
      binding: {
        purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE,
        account: {
          service: { pluginId: GITHUB_PLUGIN_ID, localId: 'github-account' },
          accountId: 'account-under-test',
        },
      },
      localInstanceKey: 'github.com',
      configuration: { v: 1, token },
    },
    observation: {
      entryRef: {
        source,
        kindId: 'pull-request',
        collisionScope: `github:${GITHUB_FIXTURE_REPOSITORY_ID}`,
        entryId: '1284',
      },
      observedAtMs: 1_760_000_700_000,
      locator: { v: 1, routingToken: 'octo-org/example-app' },
      snapshot: {
        v: 1,
        title: 'Consolidate the duplicated normalizer',
        scopeLabel: 'octo-org/example-app',
        state: { presentation: 'active', nativeLabel: 'Open' },
        facts: [],
      },
      viewer: { involvement: [] },
    },
    linkedSessions: [],
  });
}

function ExpandedDiffProbe({
  row,
}: Readonly<{ row: GithubChangedFileViewV1 }>) {
  const diff = useGithubChangedFileDiff(launchInput(), row);
  return (
    <Text testID="expanded-patch">
      {diff.state.kind === 'ready'
        ? (diff.state.value.unifiedDiff ?? diff.state.value.evidence.state)
        : diff.state.kind}
    </Text>
  );
}

function FileDisclosureProbe() {
  const [open, setOpen] = React.useState(false);
  const [path, setPath] = React.useState('src/open.ts');
  const row = React.useMemo(
    () => ({
      ...projectGithubChangedFileRows(
        [githubChangedFile({ filename: path })],
        GITHUB_DETAIL_BOUNDS_V1,
      ).rows[0]!,
      diffContinuation: null,
    }),
    [path],
  );
  return (
    <Tabs value="files" onValueChange={() => {}} ariaLabel="File probe">
      <Tabs.Item value="files" title="Files">
        <Button
          testID="toggle-file"
          title="Toggle file"
          onPress={() => setOpen((current) => !current)}
        />
        <Button
          testID="next-file"
          title="Next file"
          onPress={() => setPath('src/next.ts')}
        />
        {open ? <ExpandedDiffProbe row={row} /> : null}
      </Tabs.Item>
    </Tabs>
  );
}

async function mountRegisteredFiles(
  options: Readonly<{ misbind?: boolean; probe?: boolean }> = {},
) {
  let release!: (response: StubHttpResponse) => void;
  const pending = new Promise<StubHttpResponse>((resolve) => {
    release = resolve;
  });
  const transport = createStubGithubTransport({
    respond: (request) =>
      request.url.includes('/files?') ? pending : undefined,
  });
  const plugin = await createPluginTestkit({
    manifest: PLUGIN_MANIFEST,
    module: { activate },
    services: {
      http: transport.context.services.http,
      connectedAccounts: transport.context.services.connectedAccounts,
    },
  });
  plugins.push(plugin);
  const producerResults: unknown[] = [];
  const readSignals: AbortSignal[] = [];
  let detail!: PluginUiTestkit;
  await act(async () => {
    detail = await createPluginUiTestkit({
      identity: {
        instanceId: 'github-read-dispatch',
        mountNonce: 'github-read-dispatch-mount',
      },
      authorPlugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
      // A host context update reparses the same navigation value, just as the
      // targeted renderer receives new launch objects from the parent surface.
      surface: defineUiSurface((context) => {
        if (options.probe) return <FileDisclosureProbe />;
        const body = renderSurface({ ...context, launchInput: launchInput() });
        if (body !== null && !React.isValidElement(body))
          throw new Error('Expected a React-native surface');
        return body;
      }),
      launchInput: launchInput(),
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: {
        executeAction: async ({ action, input, signal }) => {
          if (
            typeof action === 'string' ||
            action.pluginId !== GITHUB_PLUGIN_ID
          )
            throw new Error('Wrong Action owner');
          if (input === undefined)
            throw new Error('GitHub detail reads require an input');
          if (
            action.localId ===
            GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.listChangedFiles
          )
            readSignals.push(signal);
          const misbound =
            options.misbind &&
            action.localId ===
              GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.listChangedFiles;
          const filesRequest = misbound
            ? GithubChangedFilesInputV1Schema.parse(input)
            : null;
          const result = await plugin.invokeAction(
            misbound
              ? GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readCapabilities
              : action.localId,
            filesRequest === null
              ? input
              : {
                  v: 1,
                  instance: filesRequest.instance,
                  localRef: filesRequest.localRef,
                  routingToken: filesRequest.routingToken,
                },
            { surface: 'ui', signal },
          );
          if (
            action.localId ===
            GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.listChangedFiles
          )
            producerResults.push(result);
          return result;
        },
      },
    });
  });
  mounted.push(detail);
  return { detail, transport, producerResults, release, readSignals };
}

describe('registered GitHub detail read dispatch', () => {
  it('cancels a pending old file before admitting the replacement file through the same Action', async () => {
    const { detail, transport, readSignals, release } =
      await mountRegisteredFiles({ probe: true });
    await act(async () => {
      await detail.press(
        await detail.getByRole('button', { name: 'Toggle file' }),
      );
    });
    await vi.waitFor(() =>
      expect(
        transport.requests.filter((request) => request.url.includes('/files?')),
      ).toHaveLength(1),
    );
    await act(async () => {
      await detail.press(
        await detail.getByRole('button', { name: 'Next file' }),
      );
    });
    await vi.waitFor(() =>
      expect(
        transport.requests.filter((request) => request.url.includes('/files?')),
      ).toHaveLength(2),
    );
    expect(readSignals[0]?.aborted).toBe(true);
    await act(async () => {
      release({
        status: 200,
        body: ['open', 'next'].map((name) => ({
          ...githubChangedFile({ filename: `src/${name}.ts` }),
          additions: 1,
          deletions: 1,
          changes: 2,
          patch: `@@ -1 +1 @@\n-old\n+${name}-file`,
        })),
      });
    });
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(
        document.querySelector('[data-testid="expanded-patch"]')?.textContent,
      ).toContain('+next-file');
      expect(
        document.querySelector('[data-testid="expanded-patch"]')?.textContent,
      ).not.toContain('+open-file');
    });
  });

  it('never retains another file patch when changed identity cannot be read', async () => {
    const { detail, release } = await mountRegisteredFiles({ probe: true });
    await act(async () => {
      release({
        status: 200,
        body: [
          {
            ...githubChangedFile({ filename: 'src/open.ts' }),
            additions: 1,
            deletions: 1,
            changes: 2,
            patch: '@@ -1 +1 @@\n-old\n+first-file',
          },
        ],
      });
    });
    await act(async () => {
      await detail.press(
        await detail.getByRole('button', { name: 'Toggle file' }),
      );
    });
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(
        document.querySelector('[data-testid="expanded-patch"]')?.textContent,
      ).toContain('+first-file');
    });
    await act(async () => {
      await detail.press(
        await detail.getByRole('button', { name: 'Next file' }),
      );
    });
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(
        document.querySelector('[data-testid="expanded-patch"]')?.textContent,
      ).toBe('unavailable');
    });
  });

  it('reads a body only while expanded, cancels on close, and reopens through the same registered owner', async () => {
    const { detail, transport, readSignals, release } =
      await mountRegisteredFiles({ probe: true });
    const toggle = async () => {
      await detail.press(
        await detail.getByRole('button', { name: 'Toggle file' }),
      );
    };
    expect(
      transport.requests.filter((request) => request.url.includes('/files?')),
    ).toHaveLength(0);
    await act(async () => {
      await toggle();
    });
    await vi.waitFor(() =>
      expect(
        transport.requests.filter((request) => request.url.includes('/files?')),
      ).toHaveLength(1),
    );
    expect(readSignals[0]?.aborted).toBe(false);
    await act(async () => {
      await toggle();
    });
    expect(readSignals[0]?.aborted).toBe(true);
    await act(async () => {
      release({
        status: 200,
        body: [
          {
            ...githubChangedFile({ filename: 'src/open.ts' }),
            additions: 1,
            deletions: 1,
            changes: 2,
            patch: '@@ -1 +1 @@\n-old\n+fresh',
          },
        ],
      });
    });
    expect(document.querySelector('[data-testid="expanded-patch"]')).toBeNull();
    await act(async () => {
      await toggle();
    });
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(
        document.querySelector('[data-testid="expanded-patch"]')?.textContent,
      ).toBe(
        '--- "a/src/open.ts"\n+++ "b/src/open.ts"\n@@ -1 +1 @@\n-old\n+fresh',
      );
    });
    expect(
      transport.requests.filter((request) => request.url.includes('/files?')),
    ).toHaveLength(2);
  });

  it('keeps a real pending read across reparsed launch input and populates the mounted panel', async () => {
    const { detail, transport, producerResults, release } =
      await mountRegisteredFiles();
    expect(
      transport.requests.some((request) => request.url.includes('/files?')),
    ).toBe(true);
    await act(async () => {
      await detail.updateSurface(createSurfaceContextFixture());
    });
    await act(async () => {
      release({
        status: 200,
        body: [githubChangedFile({ filename: 'src/dispatch.ts' })],
      });
    });
    expect(producerResults).toHaveLength(1);
    expect(
      GithubChangedFilesResultV1Schema.parse(producerResults[0]),
    ).toMatchObject({
      kind: 'changedFiles',
      rows: [{ path: 'src/dispatch.ts' }],
    });
    // File titles retain both path halves in separate text runs for middle ellipsis.
    expect(document.body.textContent).toContain('src/dispatch.ts');
    // A settled host update must retain the same page rather than re-read it.
    await act(async () => {
      await detail.updateSurface(createSurfaceContextFixture());
    });
    expect(document.body.textContent).toContain('src/dispatch.ts');
    expect(producerResults).toHaveLength(1);
  });

  it('opens a changed file in place to its own diff, read only when the row is opened', async () => {
    const { detail, transport, release } = await mountRegisteredFiles();
    await act(async () => {
      release({
        status: 200,
        body: [
          {
            ...githubChangedFile({ filename: 'src/open.ts' }),
            additions: 1,
            deletions: 1,
            changes: 2,
            patch: '@@ -1 +1 @@\n-old\n+fresh-line',
          },
        ],
      });
    });
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('src/open.ts'),
    );
    const filesReads = () =>
      transport.requests.filter((request) => request.url.includes('/files?'))
        .length;
    const listed = filesReads();
    expect(document.body.textContent).not.toContain('+fresh-line');
    const row = (await detail.queryAllByRole('button')).find(
      (target) => target.name?.includes('src/open.ts') === true,
    );
    if (row === undefined)
      throw new Error('Expected the changed file row to open in place');
    await act(async () => {
      await detail.press(row);
    });
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(document.body.textContent).toContain('+fresh-line');
    });
    expect(filesReads()).toBe(listed + 1);
  });

  it('refuses a mis-bound registered producer rather than presenting its result as files', async () => {
    const { detail, producerResults } = await mountRegisteredFiles({
      misbind: true,
    });
    await expect(
      detail.queryByText('src/dispatch.ts'),
    ).resolves.toBeUndefined();
    expect(producerResults).toHaveLength(1);
    expect(
      GithubChangedFilesResultV1Schema.safeParse(producerResults[0]).success,
    ).toBe(false);
    await expect(
      detail.getByText(
        describeTriageSourceFailureV1(
          {
            class: 'unsupportedContract',
            code: 'github-detail-result-unreadable',
          },
          'GitHub could not complete this read.',
        ),
      ),
    ).resolves.toBeDefined();
  });
});
