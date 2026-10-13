import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  Collection,
  DetailsPaneFooter,
  useHappierCollection,
  type CollectionAnatomy,
  type CollectionDetailRenderContext,
} from '@happier-dev/plugin-ui/components';

import { useHappierCollectionLayout } from '@happier-dev/plugin-ui/presentation';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { ESCAPE_LAYER_PRIORITIES, useEscapeLayer } from '@/keyboard/escape';
import { Text } from '@/components/ui/text/Text';
import { CoreCollectionScope } from '@/components/ui/lists/collection/CoreCollectionScope';
import { Modal } from '@/modal';
import {
  CATALOG_SURFACE_CARD_DIMENSIONS,
  CATALOG_SURFACE_LIST_ROLE,
} from '@/modal/components/card/commandSurfaceCard';
import type { CustomModalInjectedProps } from '@/modal/types';
import { t } from '@/text';

export type CapabilityAddInputContext = Readonly<{
  /** Hand a parsed item to the catalog details column (From a link, Paste a config). */
  showDetail: (itemKey: string) => void;
}>;

export type CapabilityAddMode =
  | Readonly<{ key: string; label: string; icon: IconName; kind: 'catalog' }>
  | Readonly<{
      key: string;
      label: string;
      icon: IconName;
      kind: 'input';
      renderBody: (ctx: CapabilityAddInputContext) => React.ReactNode;
    }>
  | Readonly<{
      key: string;
      label: string;
      icon: IconName;
      kind: 'handoff';
      onSelect: () => void;
    }>;

export type CapabilityAddDetailContext = Readonly<{
  /** The details are the page (a phone): the body keeps its own heading; the primary pins at the foot. */
  pushed: boolean;
  /** The primary resolved `then: 'stay'` for this item: the body shows its live state. */
  added: boolean;
}>;

export type CapabilityAddModalConfig<Item> = Readonly<{
  title: string;
  modes: readonly CapabilityAddMode[];
  initialModeKey?: string;
  sources?: Readonly<{
    renderSelect: (
      ctx: Readonly<{ openRegistries: (intent: 'manage' | 'add') => void }>,
    ) => React.ReactNode;
    renderRegistriesView: (
      ctx: Readonly<{ intent: 'manage' | 'add'; back: () => void }>,
    ) => React.ReactNode;
  }>;
  catalog: Readonly<{
    query: string;
    onQueryChange: (query: string) => void;
    searchPlaceholder: string;
    resultCountLabel?: string;
    items: readonly Item[];
    groups?: readonly Readonly<{
      key: string;
      title: string;
      trailing?: string;
      itemKeys: readonly string[];
    }>[];
    itemKey: (item: Item) => string;
    anatomy: CollectionAnatomy<Item>;
    loading: boolean;
    sourceFailures?: readonly Readonly<{
      sourceId: string;
      message: string;
      onRetry: () => void;
    }>[];
    empty: React.ReactNode;
  }>;
  renderDetail: (
    item: Item,
    ctx: CapabilityAddDetailContext,
  ) => React.ReactNode;
  detailFooter: (item: Item) => Readonly<{
    provenance?: React.ReactNode;
    primary: Readonly<{
      label: string;
      onPress: () => Promise<
        Readonly<{ itemId: string; then?: 'close' | 'stay' }>
      >;
      busy?: boolean;
      disabledReason?: string;
    }>;
  }>;
  onAdded?: (result: Readonly<{ itemId: string }>) => void;
  testID: string;
}>;

export type CapabilityAddModalHandle<Item> = Readonly<{
    close: () => void;
    update: (config: CapabilityAddModalConfig<Item>) => void;
}>;

/**
 * The one add-from-a-catalog dialog for skills, MCP servers and agents: the public `Collection` (list, `detail:
 * 'auto'`) inside the standard modal card at the catalog size role. Full-width list at rest; selecting a row narrows
 * the list and opens the details beside it with the Collection's own move; the details' close returns to the list;
 * the card never changes size. On a phone the card fills the screen and the details push.
 */
export function openCapabilityAddModal<Item>(
  config: CapabilityAddModalConfig<Item>,
): CapabilityAddModalHandle<Item> {
  const id = Modal.show({
    component: CapabilityAddModalBody as unknown as React.ComponentType<
      CustomModalInjectedProps & { config: CapabilityAddModalConfig<unknown> }
    >,
    props: { config: config as unknown as CapabilityAddModalConfig<unknown> },
    closeOnBackdrop: true,
    chrome: {
      kind: 'card',
      title: config.title,
      testID: config.testID,
      closeButtonTestID: `${config.testID}:close`,
      scrollHost: 'body',
      bodyScroll: 'none',
      dimensions: CATALOG_SURFACE_CARD_DIMENSIONS,
      phonePresentation: 'fullscreen',
    },
  });
  return {
        close: () => Modal.hide(id),
        // The catalog is live (search, loading, results): the opener hands the next config to the open dialog.
        update: (next) => Modal.update(id, { config: next as unknown as CapabilityAddModalConfig<unknown> }),
    };
}

type BodyProps<Item> = CustomModalInjectedProps &
  Readonly<{ config: CapabilityAddModalConfig<Item> }>;

export function CapabilityAddModalBody<Item>(
  props: BodyProps<Item>,
): React.ReactElement {
  const { config, onClose, setChrome } = props;
  const { catalog } = config;
  const [modeKey, setModeKey] = React.useState(
    config.initialModeKey ?? config.modes[0]?.key ?? '',
  );
  const [openKey, setOpenKey] = React.useState<string | null>(null);
  const [registries, setRegistries] = React.useState<'manage' | 'add' | null>(
    null,
  );
  const [added, setAdded] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const mode =
    config.modes.find((candidate) => candidate.key === modeKey) ??
    config.modes[0];

  // Esc closes the open details before the dialog, wherever focus is (the dialog's layer encloses this one).
  useEscapeLayer({
    priority: ESCAPE_LAYER_PRIORITIES.pane,
    enabled: openKey !== null,
    allowEditableTarget: true,
    onEscape: () => setOpenKey(null),
  });

  // One level in (Registries): the header shows a back link in the same frame, at the same size.
  React.useEffect(() => {
    if (setChrome === undefined) return;
    setChrome({
      kind: 'card',
      title: config.title,
      testID: config.testID,
      closeButtonTestID: `${config.testID}:close`,
      scrollHost: 'body',
      bodyScroll: 'none',
      dimensions: CATALOG_SURFACE_CARD_DIMENSIONS,
      phonePresentation: 'fullscreen',
      ...(registries === null
        ? {}
        : {
            leading: (
              <IconButton
                iconName="caret-left"
                accessibilityLabel={t('capabilities.add.back')}
                onPress={() => setRegistries(null)}
                testID={`${config.testID}:back`}
              />
            ),
          }),
    });
  }, [config.testID, config.title, registries, setChrome]);

  const groups = React.useMemo(() => {
    const declared = catalog.groups;
    if (declared === undefined) return undefined;
    const groupOf = new Map<string, string>();
    for (const group of declared)
      for (const key of group.itemKeys) groupOf.set(key, group.key);
    return {
      axis: declared.map((group) => ({ key: group.key, title: group.title })),
      groupOf: (item: Item) =>
        groupOf.get(catalog.itemKey(item)) ?? declared[0]!.key,
    };
  }, [catalog]);

  const model = useHappierCollection<Item>({
    items: catalog.items,
    keyOf: catalog.itemKey,
    ...(groups === undefined ? {} : { groups }),
    openKey,
    onOpenChange: setOpenKey,
  });

  const itemsByKey = React.useMemo(
    () => new Map(catalog.items.map((item) => [catalog.itemKey(item), item])),
    [catalog],
  );

  const selectMode = React.useCallback(
    (key: string) => {
      const next = config.modes.find((candidate) => candidate.key === key);
      if (next === undefined) return;
      if (next.kind === 'handoff') {
        onClose();
        next.onSelect();
        return;
      }
      setModeKey(key);
    },
    [config.modes, onClose],
  );

  const tools = (search: React.ReactNode) => (
    <View style={styles.tools}>
      <CatalogModes
        modes={config.modes}
        activeKey={mode?.key ?? ''}
        onSelect={selectMode}
        testID={config.testID}
      />
      {config.sources === undefined
        ? null
        : config.sources.renderSelect({ openRegistries: setRegistries })}
      <View style={styles.search}>{search}</View>
    </View>
  );

  const renderDetail = (
    key: string,
    context: CollectionDetailRenderContext,
  ) => {
    const item = itemsByKey.get(key);
    if (item === undefined) return null;
    return (
      <CapabilityAddDetail
        item={item}
        itemKey={key}
        config={config}
        pushed={context.pushed}
        added={added.has(key)}
        onCloseDetail={() => setOpenKey(null)}
        onPrimaryDone={(result) => {
          if (result.then === 'stay') {
            setAdded((previous) => new Set(previous).add(key));
            return;
          }
          onClose();
          config.onAdded?.({ itemId: result.itemId });
        }}
      />
    );
  };

  if (registries !== null && config.sources !== undefined) {
    return (
      <View style={styles.fill} testID={`${config.testID}:registries`}>
        {config.sources.renderRegistriesView({
          intent: registries,
          back: () => setRegistries(null),
        })}
      </View>
    );
  }

  if (mode?.kind === 'input') {
    return (
      <View style={styles.fill}>
        <View style={styles.toolsBand}>{tools(null)}</View>
        <View style={styles.fill}>
          {mode.renderBody({
            showDetail: (key) => {
              setModeKey(
                config.modes.find((m) => m.kind === 'catalog')?.key ?? modeKey,
              );
              setOpenKey(key);
            },
          })}
        </View>
      </View>
    );
  }

  return (
    <CoreCollectionScope>
      <View style={styles.fill}>
        <Collection<Item>
          model={model}
          anatomy={catalog.anatomy}
          accessibilityLabel={config.title}
          presentation="list"
          detail="auto"
          renderDetail={renderDetail}
          minListWidth={CATALOG_SURFACE_LIST_ROLE.minListWidthPx}
          minDetailWidth={CATALOG_SURFACE_LIST_ROLE.minDetailWidthPx}
          preferredListRatio={CATALOG_SURFACE_LIST_ROLE.preferredListRatio}
          loading={catalog.loading}
          empty={catalog.empty}
          search={{
            label: t('capabilities.add.searchLabel'),
            value: catalog.query,
            onValueChange: catalog.onQueryChange,
            placeholder: catalog.searchPlaceholder,
            width: 'fill',
            testID: `${config.testID}:search`,
          }}
          header={(slots) => <CatalogToolsBand open={openKey !== null}>{tools(slots.search)}</CatalogToolsBand>}
          testID={`${config.testID}:collection`}
          listTestID={`${config.testID}:list`}
          detailTestID={`${config.testID}:detail`}
        />
      </View>
    </CoreCollectionScope>
  );
}

/**
 * The modes as a tab list hugging their labels. Where the card is a phone page every label must still read whole, so
 * the glyphs step aside first (D44's order); the labels never truncate.
 */
function CatalogModes(props: Readonly<{
  modes: readonly CapabilityAddMode[];
  activeKey: string;
  onSelect: (key: string) => void;
  testID: string;
}>): React.ReactElement {
  const layout = useHappierCollectionLayout();
  const narrow = layout?.mode === 'stacked';
  return (
    <SegmentedTabBar
      tabs={props.modes.map((candidate) => ({
        id: candidate.key,
        label: candidate.label,
        ...(narrow ? {} : { icon: <Icon name={candidate.icon} size={15} /> }),
        testID: `${props.testID}:mode:${candidate.key}`,
      }))}
      activeTabId={props.activeKey}
      onSelectTab={props.onSelect}
      segmentSizing="content"
      iconPlacement="leading"
      role="tablist"
      accessibilityLabel={t('capabilities.add.modesLabel')}
    />
  );
}

/** The tools band; on a phone the pushed details are the page, so the band steps aside while they show. */
function CatalogToolsBand(props: Readonly<{ open: boolean; children: React.ReactNode }>): React.ReactElement | null {
    const layout = useHappierCollectionLayout();
    if (props.open && layout?.mode === 'stacked') return null;
    return <View style={styles.toolsBand}>{props.children}</View>;
}

function CapabilityAddDetail<Item>(
  props: Readonly<{
    item: Item;
    itemKey: string;
    config: CapabilityAddModalConfig<Item>;
    pushed: boolean;
    added: boolean;
    onCloseDetail: () => void;
    onPrimaryDone: (
      result: Readonly<{ itemId: string; then?: 'close' | 'stay' }>,
    ) => void;
  }>,
): React.ReactElement {
  const { theme } = useUnistyles();
  const footer = props.config.detailFooter(props.item);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    setError(null);
  }, [props.itemKey]);
  const press = React.useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await footer.primary.onPress();
      props.onPrimaryDone(result);
    } catch (failure) {
      setError(
        failure instanceof Error && failure.message
          ? failure.message
          : t('capabilities.add.addFailed'),
      );
    } finally {
      setBusy(false);
    }
  }, [footer.primary, props]);
  const primary = (
    <RoundButton
      title={props.added ? t('capabilities.add.added') : footer.primary.label}
      size="normal"
      loading={busy || footer.primary.busy === true}
      disabled={props.added || footer.primary.disabledReason !== undefined}
      {...(footer.primary.disabledReason === undefined
        ? {}
        : { accessibilityHint: footer.primary.disabledReason })}
      onPress={() => {
        void press();
      }}
      testID={`${props.config.testID}:primary`}
    />
  );
  const footerRow = (
    <View style={styles.footer}>
      <View style={styles.footerStart}>
        {error === null ? (
          (footer.provenance ?? null)
        ) : (
          <Text
            variant="meta"
            style={{ color: theme.colors.status.error }}
            testID={`${props.config.testID}:primary-error`}
          >
            {error}
          </Text>
        )}
      </View>
      {primary}
    </View>
  );
  return (
    <View
      style={styles.detail}
      testID={`${props.config.testID}:detail:${props.itemKey}`}
    >
      {props.pushed ? (
        <View style={styles.detailBack}>
          <IconButton
            iconName="caret-left"
            variant="plain"
            accessibilityLabel={t('capabilities.add.back')}
            onPress={props.onCloseDetail}
            testID={`${props.config.testID}:close-detail`}
          />
        </View>
      ) : (
        <View style={styles.detailClose}>
          <IconButton
            iconName="x"
            variant="plain"
            accessibilityLabel={t('capabilities.add.closeDetails')}
            onPress={props.onCloseDetail}
            testID={`${props.config.testID}:close-detail`}
          />
        </View>
      )}
      <ScrollView style={styles.fill} contentContainerStyle={[styles.detailBody, props.pushed ? styles.detailBodyPushed : null]}>
        {props.config.renderDetail(props.item, {
          pushed: props.pushed,
          added: props.added,
        })}
      </ScrollView>
      {props.pushed ? (
        <DetailsPaneFooter>{footerRow}</DetailsPaneFooter>
      ) : (
        footerRow
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  fill: { flex: 1, minHeight: 0 },
  toolsBand: {
    paddingHorizontal: theme.space.s24,
    paddingBottom: theme.space.s12,
  },
  tools: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: theme.space.s12,
  },
  search: { flexGrow: 1, flexBasis: 240, minWidth: 0 },
  detail: { flex: 1, minHeight: 0 },
  detailBack: {
    paddingHorizontal: theme.space.s16,
    paddingTop: theme.space.s8,
  },
  detailClose: {
    position: 'absolute',
    top: theme.space.s12,
    right: theme.space.s12,
    zIndex: 1,
  },
  detailBody: {
    paddingHorizontal: theme.space.s32,
    paddingTop: theme.space.s24,
    paddingBottom: theme.space.s24,
    gap: theme.space.s24,
  },
  detailBodyPushed: { paddingHorizontal: theme.space.s20, paddingTop: theme.space.s8 },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s16,
    paddingHorizontal: theme.space.s24,
    paddingVertical: theme.space.s12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.subtle,
  },
  footerStart: { flex: 1, minWidth: 0 },
}));
