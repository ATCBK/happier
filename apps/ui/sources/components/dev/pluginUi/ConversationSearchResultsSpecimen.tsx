import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { resolveAgentCatalogProjection } from '@/agents/backendCatalog/agentCatalogProjection';
import { ExternalSessionBrowseCandidatesList } from '@/components/sessions/external/browse/ExternalSessionBrowseCandidatesList';
import type { ExternalSessionBrowseCandidate } from '@/components/sessions/external/browse/useExternalSessionBrowseCandidates';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

const noop = () => {};
const QUERY = 'flaky e2e';
const HOME = '/Users/dev';
const DAY = 24 * 60 * 60 * 1000;

/** Lab `fhistory` H2: three hits in two projects, one already in Happier. */
function hits(now: number): ExternalSessionBrowseCandidate[] {
  return [
    {
      remoteSessionId: 'dev-stabilise',
      title: 'Stabilise CI on the release branch',
      updatedAtMs: now - 21 * DAY,
      searchMode: 'standard',
      messageCount: 212,
      details: { cwd: `${HOME}/happier` },
      match: {
        snippet:
          '…the flaky e2e is the settings sheet: it remounts when the viewport changes, so the test sometimes types into a sheet that is about to be replaced.',
        sourceItemId: 'a',
      },
    },
    {
      remoteSessionId: 'dev-login',
      title: 'Why does login fail on Linux runners?',
      updatedAtMs: now - 35 * DAY,
      searchMode: 'standard',
      details: { cwd: `${HOME}/happier` },
      match: {
        snippet:
          '…retrying hides a flaky e2e; the real cause is the keychain prompt on a fresh runner.',
        sourceItemId: 'b',
      },
    },
    {
      remoteSessionId: 'dev-docs',
      title: 'Docs search index',
      updatedAtMs: now - 60 * DAY,
      searchMode: 'standard',
      linkedSessionId: 'happier-docs',
      messageCount: 48,
      details: { cwd: `${HOME}/website` },
      match: {
        snippet:
          '…skip the flaky e2e for now and file it against the settings sheet.',
        sourceItemId: 'c',
      },
    },
  ];
}

/**
 * Dev specimen of Browse › Conversations (Find lab `fhistory` H2 + states) through the real list owner,
 * credential-free, so the populated, searching and failed compositions can be judged without a machine.
 */
export function ConversationSearchResultsSpecimen() {
  const [now] = React.useState(() => Date.now());
  const agentIdentity = React.useMemo(
    () => ({
      entry: resolveAgentCatalogProjection('claude', {
        enabledAgentIds: ['claude'],
      }),
      machineId: null,
      serverId: null,
      current: true,
    }),
    [],
  );
  const base = {
    candidates: [] as ExternalSessionBrowseCandidate[],
    loading: false,
    error: null,
    nextCursor: null,
    paginationRequestKey: null,
    loadingMore: false,
    searchAugmenting: false,
    searchIncomplete: false,
    annotationsIncomplete: false,
    preparation: null,
    linkingSessionId: null,
    searchQuery: QUERY,
    searchTarget: 'content' as const,
    contentSearchSupported: true,
    contentSearchSubmitted: true,
    contentCoverage: 'complete' as const,
    onSearchQueryChange: noop,
    onSearchSubmit: noop,
    selectionAuthorityGeneration: 0,
    onSelectCandidate: noop,
    onLoadMore: noop,
    onRetry: noop,
    onCancelPreparation: noop,
    agentIdentity,
    agentLabel: 'Claude Code',
    machineLabel: 'MacBook Pro',
    machineHomeDir: HOME,
  };
  const cells: ReadonlyArray<
    readonly [
      string,
      string,
      React.ComponentProps<typeof ExternalSessionBrowseCandidatesList>,
    ]
  > = [
    [
      'H2 · Results',
      'Grouped by project; each hit says whether it is in Happier; the transcript length when the Agent knows it.',
      { ...base, candidates: hits(now) },
    ],
    [
      'Searching',
      'The field’s Search becomes Stop; rows arrive where the skeleton stands.',
      { ...base, loading: true },
    ],
    [
      'More to search',
      'A first page with a continuation keeps the rows and offers the next page.',
      {
        ...base,
        candidates: hits(now).slice(0, 1),
        contentCoverage: 'partial' as const,
        nextCursor: 'dev-cursor',
        paginationRequestKey: 'dev',
      },
    ],
    [
      'Search failed',
      'The Agent could not be read: what failed, where, and Retry.',
      {
        ...base,
        error:
          'Happier couldn’t read the selected Agent’s sessions on this machine. Try again; if it keeps failing, update Happier on that machine.',
      },
    ],
    [
      'Nothing found',
      'Says what was searched, with a way to clear it.',
      { ...base, searchQuery: 'websocket backoff' },
    ],
  ];
  return (
    <View style={styles.cell} testID="dev-find-conversation-results">
      {cells.map(([title, description, props]) => (
        <View key={title} style={styles.block}>
          <Text style={styles.cellTitle}>{title}</Text>
          <Text style={styles.cellDescription}>{description}</Text>
          <View style={styles.panel}>
            <ExternalSessionBrowseCandidatesList {...props} />
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  cell: { marginTop: 28, gap: 22 },
  block: { gap: theme.space.s4 },
  cellTitle: {
    ...Typography.variant('body', 'semiBold'),
    color: theme.colors.text.primary,
  },
  cellDescription: {
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
    marginBottom: theme.space.s6,
  },
  panel: {
    height: 360,
    maxWidth: 760,
    flexDirection: 'row',
    overflow: 'hidden',
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border.default,
    backgroundColor: theme.colors.surface.base,
  },
}));
