import * as React from 'react';
import { Platform, ScrollView, View, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  Collection,
  DetailsPaneFooter,
  useHappierCollection,
  type CollectionAnatomy,
  type CollectionDetailRenderContext,
} from '@happier-dev/plugin-ui/components';

import { HappierCollectionNavigationBackClosesDetailContext, HappierCollectionRestingRowsContext, HappierPressable, useHappierCollectionLayout } from '@happier-dev/plugin-ui/presentation';

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
  /** The dialog's tools band: the mode tabs, then `field` where Browse has its search (a link field, a chosen upload). */
  tools: (field?: React.ReactNode) => React.ReactNode;
  /**
   * What the input found, in Browse's own list and details: the same rows, the same details beside the list (pushed
   * on a phone) with their pinned footer. The tools band leads it.
   */
  renderFound: <Found>(found: CapabilityAddFound<Found>) => React.ReactElement;
  /** Opens one found item's details (one uploaded skill goes straight to them); `null` closes them. */
  openDetail: (itemKey: string | null) => void;
}>;

/** An input mode's results, shown and added through the dialog's one list + details path. */
export type CapabilityAddFound<Found> = Readonly<{
  /** Stands where Browse has its search, after the mode tabs. */
  field?: React.ReactNode;
  items: readonly Found[];
  itemKey: (item: Found) => string;
  groups?: CapabilityAddModalConfig<Found>['catalog']['groups'];
  anatomy: CollectionAnatomy<Found>;
  /** The body before anything is found (what to paste or drop, and why). */
  empty: React.ReactNode;
  /** The list's pinned footer while no details are open (Add the ticked ones); drawn as given. */
  footer?: React.ReactNode;
  renderDetail: CapabilityAddModalConfig<Found>['renderDetail'];
  detailFooter: CapabilityAddModalConfig<Found>['detailFooter'];
  onAdded?: (result: Readonly<{ itemId: string }>) => void;
}>;

export type CapabilityAddMode =
  | Readonly<{ key: string; label: string; icon: IconName; kind: 'catalog' }>
  | Readonly<{
      key: string;
      label: string;
      icon: IconName;
      kind: 'input';
      renderBody: (ctx: CapabilityAddInputContext) => React.ReactNode;
      /** The body places the tools band itself (`ctx.tools`, or through `ctx.renderFound`). */
      ownsTools?: boolean;
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

export function capabilityAddChrome(frame: Readonly<{ title: string; subtitle?: string; testID: string }>) {
  return {
    kind: 'card' as const,
    // The tools band and the rows stand on 24: the title and the close control share that edge.
    headerInset: 'wide' as const,
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
  const edge = useAddDialogEdge();
  const onPhone = useDeviceType() === 'phone';
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
  // On a phone an open detail is the page, and its way back is the same link in the header ("‹ Add a skill").
  const detailBackInHeader = onPhone && openKey !== null && registries === null;
  React.useEffect(() => {
    if (setChrome === undefined) return;
    setChrome({
      ...capabilityAddChrome(config),
      ...(detailBackInHeader
        ? {
            title: null,
            leading: (
              <CapabilityAddBackLink
                label={config.title}
                onPress={() => setOpenKey(null)}
                testID={`${config.testID}:back`}
              />
            ),
          }
        : {}),
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
  }, [config.sources, config.testID, config.title, detailBackInHeader, registries, setChrome]);

  const selectMode = React.useCallback(
    (key: string) => {
      const next = config.modes.find((candidate) => candidate.key === key);
      if (next === undefined) return;
      if (next.kind === 'handoff') {
        onClose();
        next.onSelect();
        return;
      }
      // Details belong to the mode that opened them.
      setOpenKey(null);
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
      {search === null || search === undefined ? null : <View style={styles.search}>{search}</View>}
    </View>
  );

  const shared = {
    title: config.title,
    testID: config.testID,
    openKey,
    onOpenChange: setOpenKey,
    added,
    onStay: (key: string) => setAdded((previous) => new Set(previous).add(key)),
    onClose,
    detailBackInHeader,
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
    const body = mode.renderBody({
      tools: (field) => <View style={[styles.toolsBand, edge]}>{tools(field ?? null)}</View>,
      renderFound: (found) => (
        <AddCollection
          {...shared}
          items={found.items}
          itemKey={found.itemKey}
          {...(found.groups === undefined ? {} : { groups: found.groups })}
          anatomy={found.anatomy}
          loading={false}
          empty={found.empty}
          header={() => tools(found.field ?? null)}
          renderDetail={found.renderDetail}
          detailFooter={found.detailFooter}
          {...(found.onAdded === undefined ? {} : { onAdded: found.onAdded })}
          footer={found.footer === undefined ? null : found.footer}
        />
      ),
      openDetail: setOpenKey,
    });
    if (mode.ownsTools === true) return <View style={styles.fill}>{body}</View>;
    return (
      <View style={styles.fill}>
        <View style={[styles.toolsBand, edge]}>{tools(null)}</View>
        <View style={styles.fill}>
          {/* An input mode's body is a contained column like the details: sections keep its edge, not a page's. */}
          <ListPresentationProvider value="page" pageInsets="contained">
            {body}
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
    <View style={onlyFailures ? [styles.failuresAlone, edge] : styles.failures}>
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
    <AddCollection
      {...shared}
      items={catalog.items}
      itemKey={catalog.itemKey}
      {...(catalog.groups === undefined ? {} : { groups: catalog.groups })}
      anatomy={catalog.anatomy}
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
      header={(search) => <>{tools(search)}{onlyFailures ? null : failureLines}</>}
      renderDetail={config.renderDetail}
      detailFooter={config.detailFooter}
      {...(config.onAdded === undefined ? {} : { onAdded: config.onAdded })}
      footer={catalog.footer === undefined ? null : (
        <View style={[styles.listFooter, edge]} testID={`${config.testID}:list-footer`}>{catalog.footer}</View>
      )}
    />
  );
}

/**
 * The dialog's one list + details: the public `Collection` (list, `detail: 'auto'`) at the catalog size role, its
 * header in the tools band, details beside the list (pushed on a phone) and the list's footer pinned while no details
 * are open. Browse's catalog and an input mode's results (a link's skills, an upload) both render through it.
 */
function AddCollection<Item>(
  props: Readonly<{
    title: string;
    testID: string;
    items: readonly Item[];
    itemKey: (item: Item) => string;
    groups?: CapabilityAddModalConfig<Item>['catalog']['groups'];
    anatomy: CollectionAnatomy<Item>;
    loading: boolean;
    empty: React.ReactNode;
    search?: NonNullable<React.ComponentProps<typeof Collection>['search']>;
    header: (search: React.ReactNode) => React.ReactNode;
    renderDetail: CapabilityAddModalConfig<Item>['renderDetail'];
    detailFooter: CapabilityAddModalConfig<Item>['detailFooter'];
    onAdded?: (result: Readonly<{ itemId: string }>) => void;
    footer: React.ReactNode;
    openKey: string | null;
    onOpenChange: (key: string | null) => void;
    added: ReadonlySet<string>;
    onStay: (key: string) => void;
    onClose: () => void;
    detailBackInHeader: boolean;
  }>,
): React.ReactElement {
  const onPhone = useDeviceType() === 'phone';
  const { items, itemKey, openKey, onOpenChange } = props;
  const declared = props.groups;
  const groups = React.useMemo(() => {
    if (declared === undefined) return undefined;
    const groupOf = new Map<string, string>();
    for (const group of declared)
      for (const key of group.itemKeys) groupOf.set(key, group.key);
    return {
      axis: declared.map((group) => ({ key: group.key, title: group.title })),
      groupOf: (item: Item) =>
        groupOf.get(itemKey(item)) ?? declared[0]!.key,
    };
  }, [declared, itemKey]);

  const model = useHappierCollection<Item>({
    items,
    keyOf: itemKey,
    ...(groups === undefined ? {} : { groups }),
    openKey,
    onOpenChange,
  });

  const itemsByKey = React.useMemo(
    () => new Map(items.map((item) => [itemKey(item), item])),
    [items, itemKey],
  );

  // Details whose row left the list (another registry, a narrower search, a new find) close instead of standing empty.
  React.useEffect(() => {
    if (openKey !== null && !props.loading && !itemsByKey.has(openKey)) onOpenChange(null);
  }, [itemsByKey, onOpenChange, openKey, props.loading]);

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
        renderDetail={props.renderDetail}
        detailFooter={props.detailFooter}
        testID={props.testID}
        pushed={context.pushed}
        added={props.added.has(key)}
        onCloseDetail={() => onOpenChange(null)}
        onCloseDialog={props.onClose}
        onPrimaryDone={(result) => {
          if (result.then === 'stay') {
            props.onStay(key);
            return;
          }
          props.onClose();
          props.onAdded?.({ itemId: result.itemId });
        }}
      />
    );
  };

  return (
    <CoreCollectionScope>
      {/* The dialog's list keeps one rhythm: the same ruled rows and insets at rest, beside the details and loading. */}
      <HappierCollectionRestingRowsContext.Provider value={onPhone ? 'ruled-page' : 'ruled'}>
        <HappierCollectionNavigationBackClosesDetailContext.Provider value={props.detailBackInHeader}>
        <View style={styles.fill}>
          <Collection<Item>
            model={model}
            anatomy={props.anatomy}
            accessibilityLabel={props.title}
            presentation="list"
            detail="auto"
            renderDetail={renderDetail}
            minListWidth={CATALOG_SURFACE_LIST_ROLE.minListWidthPx}
            minDetailWidth={CATALOG_SURFACE_LIST_ROLE.minDetailWidthPx}
            preferredListRatio={CATALOG_SURFACE_LIST_ROLE.preferredListRatio}
            loading={props.loading}
            empty={props.empty}
            {...(props.search === undefined ? {} : { search: props.search })}
            header={(slots) => <CatalogToolsBand open={openKey !== null}>{props.header(slots.search)}</CatalogToolsBand>}
            testID={`${props.testID}:collection`}
            listTestID={`${props.testID}:list`}
            detailTestID={`${props.testID}:detail`}
          />
        </View>
        </HappierCollectionNavigationBackClosesDetailContext.Provider>
      </HappierCollectionRestingRowsContext.Provider>
      {openKey !== null ? null : props.footer}
    </CoreCollectionScope>
  );
}

/**
 * The one content edge of the dialog: the tools band, the failure line and the list footer stand on it, with the
 * title (the chrome's `headerInset`) and the rows (`restingRows`): 24 in a card, the page gutter on a phone.
 */
export function useAddDialogEdge(): ViewStyle {
  const { theme } = useUnistyles();
  const onPhone = useDeviceType() === 'phone';
  return { paddingHorizontal: onPhone ? theme.space.s16 : theme.space.s24 };
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
      // The tabs sit beside the registry select and the search field: one label size across the band.
      labelSize="field"
      compact
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
    const edge = useAddDialogEdge();
    if (props.open && layout?.mode === 'stacked') return null;
    return <View style={[styles.toolsBand, edge]}>{props.children}</View>;
}

/**
 * The pinned footer of the Add dialog: a quiet note (or the failure) at the start, the actions at the end. Where the
 * details are a phone page (`stacked`) the note reads on its own line and the actions share the full width (each child takes an equal share). A mode that
 * is not a Collection's details (Link, Upload, Paste) is a phone page exactly when the dialog is presented as one, so
 * `stacked` defaults to the device class that decides that presentation.
 */
export function CapabilityAddFooter(
  props: Readonly<{
    start: React.ReactNode;
    children: React.ReactNode;
    stacked?: boolean;
    /** Placed in a `DetailsPaneFooter`, which already draws the page's edge, hairline and padding. */
    inPageFooter?: boolean;
    testID?: string;
  }>,
): React.ReactElement {
  const narrow = useAddDialogNarrow();
  const dialogEdge = useAddDialogEdge();
  const edge = props.inPageFooter ? null : dialogEdge;
  const stacked = props.stacked ?? narrow;
  if (stacked) {
    return (
      <View testID={props.testID} style={[props.inPageFooter ? styles.footerInPage : styles.footer, styles.footerStacked, edge]}>
        {props.start === null || props.start === undefined ? null : props.start}
        <View style={styles.footerActionsStacked}>
          {React.Children.toArray(props.children).map((child, index) => (
            <View key={index} style={styles.footerSlot}>{child}</View>
          ))}
        </View>
      </View>
    );
  }
  return (
    <View testID={props.testID} style={[props.inPageFooter ? styles.footerInPage : styles.footer, edge]}>
      <View style={styles.footerStart}>{props.start}</View>
      {props.children}
    </View>
  );
}

function CapabilityAddDetail<Item>(
  props: Readonly<{
    item: Item;
    itemKey: string;
    renderDetail: CapabilityAddModalConfig<Item>['renderDetail'];
    detailFooter: CapabilityAddModalConfig<Item>['detailFooter'];
    testID: string;
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
  const edge = useAddDialogEdge();
  const footer = props.detailFooter(props.item);
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
  // On a phone page each after-add action takes an equal share of the row (lab aa Xp); the footer slots its children.
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
          testID={`${props.testID}:open-added`}
        />
      )}
      {slot(
        <RoundButton
          title={t('capabilities.add.done')}
          onPress={() => {
            props.onCloseDialog();
            afterAdd.onDone?.();
          }}
          testID={`${props.testID}:done`}
        />,
      )}
    </View>
    </RoundButtonSizeScope>
  ) : (
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
      testID={`${props.testID}:primary`}
    />
  );
  const footerRow = (
    <CapabilityAddFooter
      stacked={props.pushed}
      inPageFooter={props.pushed}
      start={
        error === null ? (
          (afterAdd?.start ?? footer.provenance ?? null)
        ) : (
          <Text
            variant="meta"
            style={{ color: theme.colors.status.error }}
            testID={`${props.testID}:primary-error`}
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
      testID={`${props.testID}:detail:${props.itemKey}`}
    >
      {/* Pushed, the Collection leads the page with the one way back; beside the list the details close here. */}
      {props.pushed ? null : (
        <View style={styles.detailClose}>
          <IconButton
            iconName="x"
            variant="plain"
            accessibilityLabel={t('capabilities.add.closeDetails')}
            onPress={props.onCloseDetail}
            testID={`${props.testID}:close-detail`}
          />
        </View>
      )}
      <ScrollView style={styles.fill} contentContainerStyle={[styles.detailBody, edge, props.pushed ? styles.detailBodyPushed : null]}>
        {/* The details are a detail page: sections read their description above the rows, in the body's own inset. */}
        <ListPresentationProvider value="page" pageInsets="contained">
          {props.renderDetail(props.item, {
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
  failuresAlone: { paddingTop: theme.space.s16 },
  detail: { flex: 1, minHeight: 0 },
  detailClose: {
    position: 'absolute',
    top: theme.space.s12,
    right: theme.space.s12,
    zIndex: 1,
  },
  // The details stand on the dialog's one content edge (`useAddDialogEdge`), which the body adds.
  detailBody: {
    // The details' header carries its own top space; the title row then sits level with the close button.
    paddingTop: theme.space.s8,
    paddingBottom: theme.space.s24,
    gap: theme.space.s24,
  },
  detailBodyPushed: { paddingTop: theme.space.s8 },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s16,
    paddingVertical: theme.space.s12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.subtle,
  },
  footerInPage: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s16 },
  footerStart: { flex: 1, minWidth: 0 },
  footerActions: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
  footerStacked: { flexDirection: 'column', alignItems: 'stretch', gap: theme.space.s12 },
  footerActionsStacked: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8, alignSelf: 'stretch' },
  footerActionsFill: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
  footerSlot: { flex: 1, minWidth: 0 },
  listFooter: {
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
