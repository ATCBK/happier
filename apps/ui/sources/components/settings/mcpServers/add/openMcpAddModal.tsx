import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  HAPPIER_PICKS_SOURCE_ID,
  type RegistryItemSummaryV1,
} from '@happier-dev/protocol/registries';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import {
  CapabilityAddModalBody,
  openCapabilityAddModalHost,
  type CapabilityAddModalConfig,
} from '@/components/capabilities/add/CapabilityAddModal';
import { buildCapabilityCollectionAnatomy } from '@/components/capabilities/row/buildCapabilityCollectionAnatomy';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import type { CustomModalInjectedProps } from '@/modal/types';
import { getMcpServerCatalogSnapshot } from '@/sync/store/settings/mcpServerCatalogSnapshot';
import { useRegistryItems } from '@/registries/useRegistryItems';
import { useRegistrySources } from '@/registries/useRegistrySources';
import { useRegistrySourcesSlot } from '@/registries/useRegistrySourcesSlot';
import { t } from '@/text';

import { McpServerMark } from '../identity/McpServerMark';
import { useMcpServersSettings } from '../useMcpServersSettings';
import {
  McpAddDetail,
  type McpAddDraft,
  type McpAddState,
} from './McpAddDetail';
import { McpPasteInput } from './McpPasteInput';
import {
  findAddedMcpServer,
  mcpAddCreateInputs,
  missingMcpAddFields,
} from './mcpAddModalConfig';
import { useMcpAddPlaces } from './useMcpAddPlaces';

export type McpAddModeKey = 'catalog' | 'paste' | 'custom';

export type OpenMcpAddModalParams = Readonly<{
  modeKey?: McpAddModeKey;
  sourceId?: string;
  query?: string;
  /** An install link to open Paste on (`?install=`): read exactly like pasted text. */
  installLink?: string;
  /** The page selects the new server (the first one added). */
  onAdded?: (serverId: string, options?: Readonly<{ afterRegistryAdd: true }>) => void;
  /** Custom: the page's draft (`/settings/mcp/new`). */
  onCustom: () => void;
}>;

const TEST_ID = 'mcp.add';

/** Add an MCP server (P7 §T6): Catalog, Paste a config, or Custom, in the one capability Add modal. */
export function openMcpAddModal(
  params: OpenMcpAddModalParams,
): Readonly<{ close: () => void }> {
  return openCapabilityAddModalHost(
    McpAddModal,
    { params },
    { title: t('capabilities.mcpAdd.title'), subtitle: t('capabilities.mcpAdd.subtitle'), testID: TEST_ID },
  );
}

type Row = RegistryItemSummaryV1;
const rowKey = (row: Row) => `${row.sourceId}|${row.itemId}`;

function rowDescription(row: Row): string | null {
  const description = row.description?.trim();
  if (!description || description === row.publisher?.name) return null;
  return description;
}

export function McpAddModal(
  props: CustomModalInjectedProps & Readonly<{ params: OpenMcpAddModalParams }>,
): React.ReactElement {
  const { params } = props;
  const { theme } = useUnistyles();
  const { settings, snapshot, scope, writable, reload } =
    useMcpServersSettings();
  const execution = useMountedActionExecution(scope);
  const { execute } = execution;
  const places = useMcpAddPlaces();
  const { sources: allSources } = useRegistrySources('mcpServer');
  const sourceTitle = React.useCallback(
    (sourceId: string) =>
      allSources.find((source) => source.id === sourceId)?.title ?? sourceId,
    [allSources],
  );

  const itemsFromSource = React.useCallback(
    (sourceId: string) =>
      settings.servers
        .filter(
          (server) =>
            server.origin?.kind === 'registry' &&
            server.origin.provenance.sourceId === sourceId,
        )
        .map((server) => ({
          title: server.title ?? server.name,
          onOpen: () => {
            props.onClose();
            params.onAdded?.(server.id);
          },
        })),
    [params, props, settings.servers],
  );
  const slot = useRegistrySourcesSlot('mcpServer', {
    itemsFromSource,
    ...(params.sourceId ? { initialSelection: params.sourceId } : {}),
    testID: `${TEST_ID}.registries`,
  });
  const [query, setQuery] = React.useState(params.query ?? '');
  const catalog = useRegistryItems({
    kind: 'mcpServer',
    ...(slot.sourceIds ? { sourceIds: slot.sourceIds } : {}),
    ...(query.trim() ? { query: query.trim() } : {}),
  });

  // What the open details read and the person set: the footer adds exactly what is shown.
  const [drafts, setDrafts] = React.useState<ReadonlyMap<string, McpAddDraft>>(
    () => new Map(),
  );
  const [adds, setAdds] = React.useState<ReadonlyMap<string, McpAddState>>(
    () => new Map(),
  );
  const createdServerId = React.useRef<string | null>(null);
  const setAdd = React.useCallback(
    (key: string, state: McpAddState) =>
      setAdds((previous) => new Map(previous).set(key, state)),
    [],
  );
  const draftSetters = React.useRef(
    new Map<string, (draft: McpAddDraft) => void>(),
  );
  const draftSetter = React.useCallback((key: string) => {
    let setter = draftSetters.current.get(key);
    if (!setter) {
      setter = (draft: McpAddDraft) =>
        setDrafts((previous) => {
          const current = previous.get(key);
          if (
            current &&
            current.item === draft.item &&
            current.model === draft.model &&
            current.values === draft.values &&
            current.where === draft.where
          )
            return previous;
          return new Map(previous).set(key, draft);
        });
      draftSetters.current.set(key, setter);
    }
    return setter;
  }, []);

  const create = React.useCallback(
    async (row: Row, draft: McpAddDraft): Promise<string> => {
      const key = rowKey(row);
      const version = draft.item?.summary.version;
      if (!version || draft.model?.supported !== true)
        throw new Error(t('capabilities.add.addFailed'));
      setAdd(key, { status: 'adding' });
      const result = await execute('mcp.servers.create', {
        expectedRevision: snapshot.revision,
        from: {
          registry: { sourceId: row.sourceId, itemId: row.itemId, version },
        },
        inputs: mcpAddCreateInputs(draft.values),
        ...(draft.model.signIn
          ? { remote: { auth: { kind: 'oauth' as const } } }
          : {}),
        ...(draft.where ? { where: draft.where } : {}),
      });
      if (!result.ok) {
        setAdd(key, {
          status: 'failed',
          error: result.errorCode ?? result.error,
        });
        throw new Error(t('capabilities.add.addFailed'));
      }
      await reload().catch(() => undefined);
      // The receipt names no id: the new server is the catalog entry that now carries this registry item's provenance.
      const fresh = getMcpServerCatalogSnapshot(scope);
      const serverId = findAddedMcpServer(fresh.value?.servers ?? [], row)?.id ?? null;
      createdServerId.current = serverId;
      setAdd(key, { status: 'added', serverId });
      return serverId ?? '';
    },
    [execute, reload, scope, setAdd, snapshot.revision],
  );

  const items = catalog.items;
  const groups = React.useMemo(() => {
    const picks = items
      .filter((row) => row.sourceId === HAPPIER_PICKS_SOURCE_ID)
      .map(rowKey);
    const rest = items
      .filter((row) => row.sourceId !== HAPPIER_PICKS_SOURCE_ID)
      .map(rowKey);
    const restTitle =
      slot.selection === 'all'
        ? t('capabilities.mcpAdd.groupAll')
        : t('capabilities.mcpAdd.groupSource', {
            source: sourceTitle(slot.selection),
          });
    return [
      ...(picks.length > 0
        ? [
            {
              key: 'picks',
              title: t('capabilities.mcpAdd.groupPicks'),
              itemKeys: picks,
            },
          ]
        : []),
      ...(rest.length > 0
        ? [{ key: 'rest', title: restTitle, itemKeys: rest }]
        : []),
    ];
  }, [items, slot.selection, sourceTitle]);

  const anatomy = React.useMemo(
    () =>
      buildCapabilityCollectionAnatomy<Row>({
        title: (row) => row.title,
        description: rowDescription,
        mark: (row) =>
          row.iconUrl ? (
            <McpServerMark transport="http" iconUrl={row.iconUrl} size={20} />
          ) : null,
        whereSummary: (row) => {
          const added =
            adds.get(rowKey(row))?.status === 'added' ||
            findAddedMcpServer(settings.servers, row) !== null;
          if (!added) return null;
          return (
            <View style={styles.inCatalog}>
              <Icon
                name="check"
                size={ICON_SIZE.xs}
                color={theme.colors.text.secondary}
              />
              <Text
                variant="meta"
                style={{ color: theme.colors.text.secondary }}
              >
                {t('capabilities.mcpAdd.inCatalog')}
              </Text>
            </View>
          );
        },
        facts: (row) => ({
          presentation: 'row',
          ...(row.publisher
            ? {
                source: {
                  kind: 'registry' as const,
                  label: row.publisher.name,
                },
              }
            : {}),
          extra: [
            t('capabilities.mcpAdd.via', { source: sourceTitle(row.sourceId) }),
          ],
        }),
        accessibilityLabel: (row) => row.title,
        testID: (row) => `${TEST_ID}.row.${row.itemId}`,
      }),
    [adds, settings.servers, sourceTitle, theme.colors.text.secondary],
  );

  const pasteBody = (
    <McpPasteInput
      testID={`${TEST_ID}.paste`}
      {...(params.installLink ? { initialText: params.installLink } : {})}
      execution={execution}
      scope={scope}
      places={places}
      writable={writable !== null}
      reloadCatalog={reload}
      onAdded={(serverIds) => {
        props.onClose();
        if (serverIds[0]) params.onAdded?.(serverIds[0]);
      }}
    />
  );

  const config = React.useMemo(
    (): CapabilityAddModalConfig<Row> => ({
      title: t('capabilities.mcpAdd.title'),
      subtitle: t('capabilities.mcpAdd.subtitle'),
      testID: TEST_ID,
      initialModeKey:
        params.modeKey ?? (params.installLink ? 'paste' : 'catalog'),
      modes: [
        {
          key: 'catalog',
          label: t('capabilities.mcpAdd.modes.catalog'),
          icon: 'magnifying-glass',
          kind: 'catalog',
        },
        {
          key: 'paste',
          label: t('capabilities.mcpAdd.modes.paste'),
          icon: 'file-text',
          kind: 'input',
          renderBody: () => pasteBody,
        },
        {
          key: 'custom',
          label: t('capabilities.mcpAdd.modes.custom'),
          icon: 'terminal',
          kind: 'handoff',
          onSelect: params.onCustom,
        },
      ],
      sources: slot.sources,
      catalog: {
        query,
        onQueryChange: setQuery,
        searchPlaceholder: t('capabilities.mcpAdd.searchPlaceholder', {
          count: catalog.pages.reduce<number | null>(
            (sum, page) =>
              page.total === undefined || sum === null
                ? null
                : sum + page.total,
            catalog.pages.length > 0 ? 0 : null,
          ),
        }),
        items,
        groups,
        itemKey: rowKey,
        anatomy,
        loading: catalog.loading && items.length === 0,
        sourceFailures: catalog.sourceFailures.map((failure) => ({
          ...failure,
          message: `${sourceTitle(failure.sourceId)} · ${failure.message}`,
        })),
        empty: <CatalogEmpty query={query} onClear={() => setQuery('')} />,
      },
      renderDetail: (row) => (
        <McpAddDetail
          key={rowKey(row)}
          testID={TEST_ID}
          row={row}
          sourceTitle={sourceTitle(row.sourceId)}
          existing={findAddedMcpServer(settings.servers, row)}
          state={adds.get(rowKey(row)) ?? null}
          scope={scope}
          places={places}
          onDraft={draftSetter(rowKey(row))}
        />
      ),
      detailFooter: (row) => {
        const key = rowKey(row);
        const draft = drafts.get(key);
        const state = adds.get(key);
        const existing = findAddedMcpServer(settings.servers, row);
        const model = draft?.model ?? null;
        if (existing !== null && state?.status !== 'added') {
          return {
            primary: {
              label: t('capabilities.mcpAdd.open'),
              onPress: async () => ({ itemId: existing.id }),
            },
          };
        }
        const supported = model?.supported === true ? model : null;
        const missing = supported
          ? missingMcpAddFields(supported.fields, draft!.values)
          : [];
        const note = supported ? (
          <View style={styles.provenance}>
            <Icon
              name={supported.signIn ? 'globe' : 'lock'}
              size={ICON_SIZE.xs}
              color={theme.colors.text.secondary}
            />
            <Text variant="meta" style={{ color: theme.colors.text.secondary }}>
              {supported.signIn && supported.remoteHost
                ? t('capabilities.mcpAdd.detail.signInNote', {
                    host: supported.remoteHost,
                  })
                : t('capabilities.mcpAdd.detail.runsNote')}
            </Text>
          </View>
        ) : undefined;
        return {
          ...(note ? { provenance: note } : {}),
          primary: {
            label: supported?.signIn
              ? t('capabilities.mcpAdd.addAndSignIn')
              : t('capabilities.mcpAdd.addServer'),
            busy: state?.status === 'adding',
            ...(writable === null
              ? { disabledReason: t('capabilities.add.addFailed') }
              : model !== null && !model.supported
                ? {
                    disabledReason: t('capabilities.mcpAdd.detail.unsupported'),
                  }
                : !draft?.item || !supported
                  ? { disabledReason: t('capabilities.mcpAdd.detail.loading') }
                  : missing.length > 0
                    ? {
                        disabledReason: t(
                          'capabilities.mcpAdd.detail.stillNeeded',
                          {
                            count: missing.length,
                          },
                        ),
                      }
                    : {}),
            onPress: async () => {
              const serverId = await create(row, draft!);
              return { itemId: serverId };
            },
          },
        };
      },
      onAdded: ({ itemId }) => {
        if (itemId) params.onAdded?.(itemId, createdServerId.current === itemId
          ? { afterRegistryAdd: true } : undefined);
      },
    }),
    [
      adds,
      anatomy,
      catalog.loading,
      catalog.pages,
      catalog.sourceFailures,
      create,
      draftSetter,
      drafts,
      groups,
      items,
      pasteBody,
      params,
      places,
      query,
      scope,
      settings.servers,
      slot.sources,
      sourceTitle,
      theme.colors.text.secondary,
      writable,
    ],
  );

  return <CapabilityAddModalBody {...props} config={config} />;
}

function CatalogEmpty(props: Readonly<{ query: string; onClear: () => void }>) {
  const { theme } = useUnistyles();
  const query = props.query.trim();
  return (
    <View style={styles.empty}>
      <Text variant="body" style={{ color: theme.colors.text.secondary }}>
        {query
          ? t('capabilities.mcpAdd.noMatch', { query })
          : t('capabilities.mcpAdd.nothingHere')}
      </Text>
      {query ? (
        <RoundButton
          size="small"
          display="inverted"
          title={t('capabilities.mcpAdd.clear')}
          onPress={props.onClear}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  inCatalog: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s4,
  },
  provenance: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
  },
  empty: {
    alignItems: 'center',
    gap: theme.space.s12,
    paddingVertical: theme.space.s32,
  },
}));
