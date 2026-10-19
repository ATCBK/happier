import * as React from 'react';
import { Platform, ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  Collection,
  DetailsPaneFooter,
  useHappierCollection,
  type CollectionAnatomy,
  type CollectionDetailRenderContext,
} from '@happier-dev/plugin-ui/components';

import { HappierCollectionRestingRowsContext, HappierPressable, useHappierCollectionLayout } from '@happier-dev/plugin-ui/presentation';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { RoundButton, RoundButtonSizeScope } from '@/components/ui/buttons/RoundButton';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { ESCAPE_LAYER_PRIORITIES, useEscapeLayer } from '@/keyboard/escape';
import { Text } from '@/components/ui/text/Text';
import { CoreCollectionScope } from '@/components/ui/lists/collection/CoreCollectionScope';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { useLocalSearchParams, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { Modal } from '@/modal';
import {
  CATALOG_SURFACE_CARD_DIMENSIONS,
  CATALOG_SURFACE_LIST_ROLE,
} from '@/modal/components/card/commandSurfaceCard';
import type { CustomModalInjectedProps } from '@/modal/types';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';

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
  /** The header's purpose line ("From a registry, a Happier plugin, or your own command."). */
  subtitle?: string;
  modes: readonly CapabilityAddMode[];
  initialModeKey?: string;
  sources?: Readonly<{
    renderSelect: (
      ctx: Readonly<{ openRegistries: (intent: 'manage' | 'add') => void }>,
    ) => React.ReactNode;
    renderRegistriesView: (
      ctx: Readonly<{ intent: 'manage' | 'add'; back: () => void }>,
    ) => React.ReactNode;
    /** The header one level in ("Registries" · "Where Browse looks for skills."); the back link names this dialog. */
    registriesHeader: Readonly<{ title: string; subtitle?: string }>;
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
    /** One quiet line pinned under the list while no details are open (what the source checks, lab aa L). */
    footer?: React.ReactNode;
  }>;
  renderDetail: (
    item: Item,
    ctx: CapabilityAddDetailContext,
  ) => React.ReactNode;
  detailFooter: (item: Item) => Readonly<{
    provenance?: React.ReactNode;
    primary: Readonly<{
      label: string;
      /** `null`: the person backed out (declined the confirm); nothing changes. */
      onPress: () => Promise<
        Readonly<{ itemId: string; then?: 'close' | 'stay' }> | null
      >;
      busy?: boolean;
      disabledReason?: string;
    }>;
    /**
     * After the primary resolved `then: 'stay'`: the footer's note, an optional way to the added item (bordered),
     * and Done (the primary), which closes the dialog (lab aa X: "Open Junie · Done").
     */
    afterAdd?: Readonly<{
      start?: React.ReactNode;
      open?: Readonly<{ label: string; onPress: () => void }>;
      onDone?: () => void;
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
    chrome: capabilityAddChrome(config),
  });
  return {
        close: () => Modal.hide(id),
        // The catalog is live (search, loading, results): the opener hands the next config to the open dialog.
        update: (next) => Modal.update(id, { config: next as unknown as CapabilityAddModalConfig<unknown> }),
    };
}

/**
 * The same dialog with its live state owned inside it: `Host` runs the kind's hooks (catalog, search, selection)
 * and renders `CapabilityAddModalBody` with the injected props, so any page entry can open it without holding
 * the catalog state itself. Same frame, size and phone presentation as `openCapabilityAddModal`.
 */
export function openCapabilityAddModalHost<P extends Readonly<Record<string, unknown>>>(
  Host: React.ComponentType<CustomModalInjectedProps & P>,
  props: P,
  frame: Readonly<{ title: string; subtitle?: string; testID: string; onRequestClose?: () => void }>,
): Readonly<{ close: () => void }> {
  const id = Modal.show({
    component: Host as unknown as React.ComponentType<CustomModalInjectedProps & Readonly<Record<string, unknown>>>,
    props,
    closeOnBackdrop: true,
    chrome: capabilityAddChrome(frame),
    ...(frame.onRequestClose ? { onRequestClose: frame.onRequestClose } : {}),
  });
  return { close: () => Modal.hide(id) };
}

function capabilityAddChrome(frame: Readonly<{ title: string; subtitle?: string; testID: string }>) {
  return {
    kind: 'card' as const,
    title: frame.title,
    // Explicit nulls: the chrome owner merges patches, so leaving Registries must clear its back link and subtitle.
    leading: null,
    subtitle: frame.subtitle ?? null,
    testID: frame.testID,
    closeButtonTestID: `${frame.testID}:close`,
    scrollHost: 'body' as const,
    bodyScroll: 'none' as const,
    dimensions: CATALOG_SURFACE_CARD_DIMENSIONS,
    phonePresentation: 'fullscreen' as const,
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
      ...capabilityAddChrome(config),
      ...(registries === null || config.sources === undefined
        ? {}
        : {
            title: config.sources.registriesHeader.title,
            ...(config.sources.registriesHeader.subtitle === undefined ? {} : { subtitle: config.sources.registriesHeader.subtitle }),
            leading: (
              <CapabilityAddBackLink
                label={config.title}
                onPress={() => setRegistries(null)}
                testID={`${config.testID}:back`}
              />
            ),
          }),
    });
  }, [config.sources, config.testID, config.title, registries, setChrome]);

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
      {config.sources === undefined || mode?.kind !== 'catalog'
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
        onCloseDialog={onClose}
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
          {/* An input mode's body is a contained column like the details: sections keep its edge, not a page's. */}
          <ListPresentationProvider value="page" pageInsets="contained">
          {mode.renderBody({
            showDetail: (key) => {
              setModeKey(
                config.modes.find((m) => m.kind === 'catalog')?.key ?? modeKey,
              );
              setOpenKey(key);
            },
          })}
          </ListPresentationProvider>
        </View>
      </View>
    );
  }

  // One registry failing never empties the others: each failed source keeps one quiet line with its own Retry. When
  // nothing came back at all, that line is the state, never "no results".
  const failures = catalog.sourceFailures ?? [];
  const onlyFailures = failures.length > 0 && catalog.items.length === 0 && !catalog.loading;
  const failureLines = failures.length === 0 ? null : (
    <View style={onlyFailures ? styles.failuresAlone : styles.failures}>
      {failures.map((failure) => (
        <SurfaceStateCard
          key={failure.sourceId}
          kind="warning"
          size="line"
          title={failure.message}
          action={{ label: t('common.retry'), onPress: failure.onRetry, testID: `${config.testID}:sourceFailure:${failure.sourceId}:retry` }}
          testID={`${config.testID}:sourceFailure:${failure.sourceId}`}
        />
      ))}
    </View>
  );

  return (
    <CoreCollectionScope>
      {/* The dialog's list keeps one rhythm: the same ruled rows and insets at rest, beside the details and loading. */}
      <HappierCollectionRestingRowsContext.Provider value="ruled">
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
            empty={onlyFailures ? failureLines : catalog.empty}
            search={{
              label: t('capabilities.add.searchLabel'),
              value: catalog.query,
              onValueChange: catalog.onQueryChange,
              placeholder: catalog.searchPlaceholder,
              width: 'fill',
              testID: `${config.testID}:search`,
            }}
            header={(slots) => <CatalogToolsBand open={openKey !== null}>{tools(slots.search)}{onlyFailures ? null : failureLines}</CatalogToolsBand>}
            testID={`${config.testID}:collection`}
            listTestID={`${config.testID}:list`}
            detailTestID={`${config.testID}:detail`}
          />
        </View>
      </HappierCollectionRestingRowsContext.Provider>
      {catalog.footer === undefined || openKey !== null ? null : (
        <View style={styles.listFooter} testID={`${config.testID}:list-footer`}>{catalog.footer}</View>
      )}
    </CoreCollectionScope>
  );
}

/**
 * Whether the dialog reads as a phone page. A Collection's own layout says so for its list and details; an input mode
 * (Link, Upload, Paste) sits outside any Collection, so there the device class that makes the card a full-screen page
 * decides. One answer for the tabs and the footer.
 */
function useAddDialogNarrow(): boolean {
  const layout = useHappierCollectionLayout();
  const onPhone = useDeviceType() === 'phone';
  return onPhone || layout?.mode === 'stacked';
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
  const narrow = useAddDialogNarrow();
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

/** One level in, the way back names where it leads ("‹ Add a skill"), on the header's title line. */
function CapabilityAddBackLink(props: Readonly<{ label: string; onPress: () => void; testID: string }>): React.ReactElement {
  const { theme } = useUnistyles();
  return (
    <HappierPressable
      testID={props.testID}
      onPress={props.onPress}
      accessibilityRole="button"
      accessibilityLabel={t('capabilities.add.backTo', { title: props.label })}
      style={styles.backLink}
    >
      <Icon name="caret-left" size={ICON_SIZE.sm} color={theme.colors.text.secondary} />
      <Text variant="body" style={{ color: theme.colors.text.secondary }} numberOfLines={1}>{props.label}</Text>
    </HappierPressable>
  );
}

/** The tools band; on a phone the pushed details are the page, so the band steps aside while they show. */
function CatalogToolsBand(props: Readonly<{ open: boolean; children: React.ReactNode }>): React.ReactElement | null {
    const layout = useHappierCollectionLayout();
    if (props.open && layout?.mode === 'stacked') return null;
    return <View style={styles.toolsBand}>{props.children}</View>;
}

/**
 * The pinned footer of the Add dialog: a quiet note (or the failure) at the start, the actions at the end. Where the
 * details are a phone page (`stacked`) the note reads on its own line and the actions share the full width. A mode that
 * is not a Collection's details (Link, Upload, Paste) is a phone page exactly when the dialog is presented as one, so
 * `stacked` defaults to the device class that decides that presentation.
 */
export function CapabilityAddFooter(
  props: Readonly<{ start: React.ReactNode; children: React.ReactNode; stacked?: boolean; testID?: string }>,
): React.ReactElement {
  const narrow = useAddDialogNarrow();
  const stacked = props.stacked ?? narrow;
  if (stacked) {
    return (
      <View testID={props.testID} style={[styles.footer, styles.footerStacked]}>
        {props.start === null || props.start === undefined ? null : props.start}
        <View style={styles.footerActionsStacked}>{props.children}</View>
      </View>
    );
  }
  return (
    <View testID={props.testID} style={styles.footer}>
      <View style={styles.footerStart}>{props.start}</View>
      {props.children}
    </View>
  );
}

function CapabilityAddDetail<Item>(
  props: Readonly<{
    item: Item;
    itemKey: string;
    config: CapabilityAddModalConfig<Item>;
    pushed: boolean;
    added: boolean;
    onCloseDetail: () => void;
    onCloseDialog: () => void;
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
      if (result !== null) props.onPrimaryDone(result);
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
  const afterAdd = props.added ? footer.afterAdd : undefined;
  // On a phone page each action takes an equal share of the row (lab aa Xp).
  const slot = (node: React.ReactNode) => (props.pushed ? <View style={styles.footerSlot}>{node}</View> : node);
  const primary = afterAdd !== undefined ? (
    <RoundButtonSizeScope size="normal" presentation="uniform">
    <View style={props.pushed ? styles.footerActionsFill : styles.footerActions}>
      {afterAdd.open === undefined ? null : slot(
        <RoundButton
          title={afterAdd.open.label}
          display="secondary"
          onPress={() => {
            props.onCloseDialog();
            afterAdd.open?.onPress();
          }}
          testID={`${props.config.testID}:open-added`}
        />
      )}
      {slot(
        <RoundButton
          title={t('capabilities.add.done')}
          onPress={() => {
            props.onCloseDialog();
            afterAdd.onDone?.();
          }}
          testID={`${props.config.testID}:done`}
        />,
      )}
    </View>
    </RoundButtonSizeScope>
  ) : slot(
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
    />,
  );
  const footerRow = (
    <CapabilityAddFooter
      stacked={props.pushed}
      start={
        error === null ? (
          (afterAdd?.start ?? footer.provenance ?? null)
        ) : (
          <Text
            variant="meta"
            style={{ color: theme.colors.status.error }}
            testID={`${props.config.testID}:primary-error`}
          >
            {error}
          </Text>
        )
      }
    >
      {primary}
    </CapabilityAddFooter>
  );
  return (
    <View
      style={styles.detail}
      testID={`${props.config.testID}:detail:${props.itemKey}`}
    >
      {/* Pushed, the Collection leads the page with the one way back; beside the list the details close here. */}
      {props.pushed ? null : (
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
        {/* The details are a detail page: sections read their description above the rows, in the body's own inset. */}
        <ListPresentationProvider value="page" pageInsets="contained">
          {props.config.renderDetail(props.item, {
            pushed: props.pushed,
            added: props.added,
          })}
        </ListPresentationProvider>
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
  failures: { paddingTop: theme.space.s12 },
  failuresAlone: { paddingHorizontal: theme.space.s24, paddingTop: theme.space.s16 },
  detail: { flex: 1, minHeight: 0 },
  detailClose: {
    position: 'absolute',
    top: theme.space.s12,
    right: theme.space.s12,
    zIndex: 1,
  },
  detailBody: {
    paddingHorizontal: theme.space.s32,
    // The details' header carries its own top space; the title row then sits level with the close button.
    paddingTop: theme.space.s8,
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
  footerActions: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
  footerStacked: { flexDirection: 'column', alignItems: 'stretch', gap: theme.space.s12 },
  footerActionsStacked: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8, alignSelf: 'stretch' },
  footerActionsFill: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
  footerSlot: { flex: 1, minWidth: 0 },
  listFooter: {
    paddingHorizontal: theme.space.s24,
    paddingVertical: theme.space.s12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.subtle,
  },
  backLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s4,
    minHeight: resolveMinimumInteractiveTargetSize(Platform.OS),
    paddingRight: theme.space.s16,
  },
}));

/**
 * Page-level deep link (P5 §4.5): `?add=<modeKey>&source=<sourceId>&q=<query>` opens the Add modal once on the page
 * route, then the page replaces its own URL without the params (no mount write to synced state). `?install=<payload>`
 * is the install-link form (MCP servers): it opens the dialog with that payload for its paste mode.
 */
export function useCapabilityAddRouteParams(
  open: (params: Readonly<{ modeKey?: string; sourceId?: string; query?: string; install?: string }>) => void,
  clearHref: string,
): void {
  const params = useLocalSearchParams<{ add?: string | string[]; source?: string | string[]; q?: string | string[]; install?: string | string[] }>();
  const router = useRouter();
  const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) || undefined;
  const add = first(params.add);
  const sourceId = first(params.source);
  const query = first(params.q);
  const install = first(params.install);
  const openRef = React.useRef(open);
  openRef.current = open;
  const handled = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (add === undefined && install === undefined) return;
    const key = JSON.stringify([add, sourceId, query, install]);
    if (handled.current === key) return;
    // On a cold deep link the page mounts before the modal host registers: open on the next turn.
    const timer = setTimeout(() => {
      handled.current = key;
      openRef.current({
        ...(add ? { modeKey: add } : {}),
        ...(sourceId ? { sourceId } : {}),
        ...(query ? { query } : {}),
        ...(install ? { install } : {}),
      });
      router.replace(clearHref as never);
    }, 0);
    return () => clearTimeout(timer);
  }, [add, clearHref, install, query, router, sourceId]);
}
