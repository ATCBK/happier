import * as React from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { HAPPIER_SPACE_STEPS } from '../../environment/spacing.js';
import {
  HappierCollectionNavigationBackClosesDetailContext,
  useHappierCollectionLayout,
} from '../collection/collectionLayout.js';
import { HappierCollectionRestingRowsContext } from '../collection/CollectionList.js';
import { useHappierCollection } from '../collection/useCollection.js';
// Types only: the list itself is the caller's (`host.Collection`, the public Collection), so this owner adds no
// runtime dependency on the components layer.
import type {
  CollectionAnatomy,
  CollectionDetailRenderContext,
  CollectionProps,
} from '../../components/Collection.js';

/**
 * The Add dialog's body (Capabilities A7 ruling 1): the ways to add as tabs, the catalog list with its details beside
 * it (pushed on a phone), the pinned footer and the registry selector. One owner for Happier's Add a skill, Add a
 * server and Add an agent dialogs and for a plugin that adds its own installable things inside its own page or sheet.
 * The frame around it (a modal card, a sheet, a page) and the way back from one level in stay the caller's.
 */

/** The list/detail split of a catalog: the list keeps its width, the details take the rest. */
export const HAPPIER_CATALOG_LIST_ROLE = Object.freeze({
  minListWidthPx: 320,
  minDetailWidthPx: 440,
  preferredListRatio: 0.34,
});

export type HappierCapabilityAddMode<Icon extends string = string> =
  | Readonly<{ key: string; label: string; icon: Icon; kind: 'catalog' }>
  | Readonly<{
      key: string;
      label: string;
      icon: Icon;
      kind: 'input';
      renderBody: (ctx: HappierCapabilityAddInputContext) => React.ReactNode;
      /** The body places the tools band itself (`ctx.tools`, or through `ctx.renderFound`). */
      ownsTools?: boolean;
    }>
  | Readonly<{
      key: string;
      label: string;
      icon: Icon;
      kind: 'handoff';
      onSelect: () => void;
    }>;

export type HappierCapabilityAddInputContext = Readonly<{
  /** The tools band: the mode tabs, then `field` where Browse has its search (a link field, a chosen upload). */
  tools: (field?: React.ReactNode) => React.ReactNode;
  /** What the input found, in Browse's own list and details, with the tools band leading it. */
  renderFound: <Found>(
    found: HappierCapabilityAddFound<Found>,
  ) => React.ReactElement;
  /** Opens one found item's details (one uploaded skill goes straight to them); `null` closes them. */
  openDetail: (itemKey: string | null) => void;
}>;

export type HappierCapabilityAddGroups = readonly Readonly<{
  key: string;
  title: string;
  trailing?: string;
  itemKeys: readonly string[];
}>[];

/** An input mode's results, shown and added through the body's one list + details path. */
export type HappierCapabilityAddFound<Found> = Readonly<{
  field?: React.ReactNode;
  items: readonly Found[];
  itemKey: (item: Found) => string;
  groups?: HappierCapabilityAddGroups;
  anatomy: CollectionAnatomy<Found>;
  /** The body before anything is found (what to paste or drop, and why). */
  empty: React.ReactNode;
  /** The list's pinned footer while no details are open (Add the ticked ones); drawn as given. */
  footer?: React.ReactNode;
  renderDetail: HappierCapabilityAddConfig<Found>['renderDetail'];
  detailFooter: HappierCapabilityAddConfig<Found>['detailFooter'];
  onAdded?: (result: Readonly<{ itemId: string }>) => void;
}>;

export type HappierCapabilityAddDetailContext = Readonly<{
  /** The details are the page (a phone): the body keeps its own heading; the primary pins at the foot. */
  pushed: boolean;
  /** The primary resolved `then: 'stay'` for this item: the body shows its live state. */
  added: boolean;
}>;

export type HappierCapabilityAddDetailFooter = Readonly<{
  provenance?: React.ReactNode;
  primary: Readonly<{
    label: string;
    /** `null`: the person backed out (declined the confirm); nothing changes. */
    onPress: () => Promise<Readonly<{
      itemId: string;
      then?: 'close' | 'stay';
    }> | null>;
    busy?: boolean;
    disabledReason?: string;
  }>;
  /** After the primary resolved `then: 'stay'`: the footer's note, an optional way to the added item, and Done. */
  afterAdd?: Readonly<{
    start?: React.ReactNode;
    open?: Readonly<{ label: string; onPress: () => void }>;
    onDone?: () => void;
  }>;
}>;

export type HappierCapabilityAddConfig<
  Item,
  Icon extends string = string,
> = Readonly<{
  title: string;
  /** The header's purpose line; the caller's frame draws it. */
  subtitle?: string;
  modes: readonly HappierCapabilityAddMode<Icon>[];
  initialModeKey?: string;
  /** The person presented another mode; use this to demand only that mode's data. */
  onModeChange?: (key: string) => void;
  /** The registry selector beside the tabs while Browse shows, and the registries view one level in. */
  sources?: Readonly<{
    renderSelect: (
      ctx: Readonly<{ openRegistries: (intent: 'manage' | 'add') => void }>,
    ) => React.ReactNode;
    renderRegistriesView: (
      ctx: Readonly<{ intent: 'manage' | 'add'; back: () => void }>,
    ) => React.ReactNode;
    /** The header one level in ("Registries" · "Where Browse looks for skills."). */
    registriesHeader: Readonly<{ title: string; subtitle?: string }>;
  }>;
  catalog: Readonly<{
    query: string;
    onQueryChange: (query: string) => void;
    searchPlaceholder: string;
    resultCountLabel?: string;
    items: readonly Item[];
    groups?: HappierCapabilityAddGroups;
    itemKey: (item: Item) => string;
    anatomy: CollectionAnatomy<Item>;
    loading: boolean;
    sourceFailures?: readonly Readonly<{
      sourceId: string;
      message: string;
      onRetry: () => void;
    }>[];
    empty: React.ReactNode;
    /** One quiet line pinned under the list while no details are open (what the source checks). */
    footer?: React.ReactNode;
  }>;
  renderDetail: (
    item: Item,
    ctx: HappierCapabilityAddDetailContext,
  ) => React.ReactNode;
  detailFooter: (item: Item) => HappierCapabilityAddDetailFooter;
  onAdded?: (result: Readonly<{ itemId: string }>) => void;
  testID: string;
}>;

/** Where the body stands, for the caller's frame: its own header, an open detail on a phone, or the registries. */
export type HappierCapabilityAddLevel =
  | Readonly<{ kind: 'root' }>
  | Readonly<{ kind: 'detail'; back: () => void }>
  | Readonly<{
      kind: 'registries';
      header: Readonly<{ title: string; subtitle?: string }>;
      back: () => void;
    }>;

/** The words the body says itself. */
export type HappierCapabilityAddLabels = Readonly<{
  modesLabel: string;
  searchLabel: string;
  retry: string;
  closeDetails: string;
  added: string;
  done: string;
  addFailed: string;
}>;

/** The primitives the body draws with; Happier binds its own, the public adapter binds public components. */
export type HappierCapabilityAddHost<Icon extends string = string> = Readonly<{
  /** The public Collection: the list and its details. */
  Collection: <Item>(props: CollectionProps<Item>) => React.ReactElement;
  /** The page footer a pushed detail pins its primary in (the public `DetailsPaneFooter`). */
  DetailsFooter: React.ComponentType<Readonly<{ children: React.ReactNode }>>;
  ModeTabs: React.ComponentType<
    Readonly<{
      modes: readonly Readonly<{ key: string; label: string; icon: Icon }>[];
      activeKey: string;
      onSelect: (key: string) => void;
      /** A phone page: every label still reads whole, so the glyphs step aside. */
      narrow: boolean;
      accessibilityLabel: string;
      testID: string;
    }>
  >;
  Button: React.ComponentType<
    Readonly<{
      title: string;
      display: 'primary' | 'secondary';
      loading?: boolean;
      disabled?: boolean;
      accessibilityHint?: string;
      onPress: () => void;
      testID: string;
    }>
  >;
  /** Several buttons side by side share one size. */
  ButtonRow?: React.ComponentType<Readonly<{ children: React.ReactNode }>>;
  CloseDetail: React.ComponentType<
    Readonly<{
      accessibilityLabel: string;
      onPress: () => void;
      testID: string;
    }>
  >;
  /** One failed source's quiet line with its own Retry. */
  SourceFailure: React.ComponentType<
    Readonly<{
      title: string;
      retryLabel: string;
      onRetry: () => void;
      retryTestID: string;
      testID: string;
    }>
  >;
  ErrorText: React.ComponentType<
    Readonly<{ children: string; testID: string }>
  >;
  /** Wraps the list (the caller's collection scope). */
  CollectionScope?: React.ComponentType<
    Readonly<{ children: React.ReactNode }>
  >;
  /** Wraps an input mode's body and the details' body: a contained column whose sections read like a page's. */
  ContainedPage?: React.ComponentType<Readonly<{ children: React.ReactNode }>>;
  /** Escape closes the open details before the frame (the caller's key layer). */
  useDismissDetail?: (enabled: boolean, onDismiss: () => void) => void;
}>;

export type HappierCapabilityAddBodyProps<
  Item,
  Icon extends string = string,
> = Readonly<{
  config: HappierCapabilityAddConfig<Item, Icon>;
  /** Closes the frame (Done, a handoff mode, an added item). */
  onClose: () => void;
  /** Where the body stands, for the frame's header and its way back. */
  onLevelChange?: (level: HappierCapabilityAddLevel) => void;
  /** The frame is a phone page (the card fills the screen, details push). */
  phone: boolean;
  labels: HappierCapabilityAddLabels;
  host: HappierCapabilityAddHost<Icon>;
  /** The caller's spacing steps and hairline. */
  space?: Readonly<Record<'s4' | 's8' | 's12' | 's16' | 's24', number>>;
  hairlineColor: string;
}>;

type Shared = Readonly<{
  space: NonNullable<HappierCapabilityAddBodyProps<unknown>['space']>;
  edge: Readonly<{ paddingHorizontal: number }>;
  phone: boolean;
  hairlineColor: string;
  labels: HappierCapabilityAddLabels;
  /** Every slot but the tabs, which the body draws with its own mode type. */
  host: Omit<HappierCapabilityAddHost, 'ModeTabs'>;
}>;
const SharedContext = React.createContext<Shared | null>(null);
function useShared(): Shared {
  const shared = React.useContext(SharedContext);
  if (shared === null)
    throw new Error(
      'The Add body parts render inside HappierCapabilityAddBody.',
    );
  return shared;
}

const noDismiss = (_enabled: boolean, _onDismiss: () => void) => {};
const PassThrough = ({ children }: Readonly<{ children: React.ReactNode }>) => (
  <>{children}</>
);

export function HappierCapabilityAddBody<Item, Icon extends string = string>(
  props: HappierCapabilityAddBodyProps<Item, Icon>,
): React.ReactElement {
  const { config, onClose, onLevelChange, host } = props;
  const space = props.space ?? HAPPIER_SPACE_STEPS;
  const edge = React.useMemo(
    () => ({ paddingHorizontal: props.phone ? space.s16 : space.s24 }),
    [props.phone, space],
  );
  const shared = React.useMemo<Shared>(
    () => ({
      space,
      edge,
      phone: props.phone,
      hairlineColor: props.hairlineColor,
      labels: props.labels,
      host,
    }),
    [space, edge, props.phone, props.hairlineColor, props.labels, host],
  );
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

  const useDismissDetail = host.useDismissDetail ?? noDismiss;
  useDismissDetail(openKey !== null, () => setOpenKey(null));

  // One level in (Registries), or an open detail on a phone, where the details are the page: the frame shows the way back.
  const detailBackInHeader =
    props.phone && openKey !== null && registries === null;
  const registriesHeader = config.sources?.registriesHeader;
  React.useEffect(() => {
    if (onLevelChange === undefined) return;
    if (registries !== null && registriesHeader !== undefined)
      onLevelChange({
        kind: 'registries',
        header: registriesHeader,
        back: () => setRegistries(null),
      });
    else if (detailBackInHeader)
      onLevelChange({ kind: 'detail', back: () => setOpenKey(null) });
    else onLevelChange({ kind: 'root' });
  }, [detailBackInHeader, onLevelChange, registries, registriesHeader]);

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
      config.onModeChange?.(key);
    },
    [config.modes, config.onModeChange, onClose],
  );

  const tools = (search: React.ReactNode) => (
    <View style={[styles.tools, { gap: space.s12 }]}>
      <CatalogModes
        ModeTabs={host.ModeTabs}
        modes={config.modes}
        activeKey={mode?.key ?? ''}
        onSelect={selectMode}
        testID={config.testID}
      />
      {config.sources === undefined || mode?.kind !== 'catalog'
        ? null
        : config.sources.renderSelect({ openRegistries: setRegistries })}
      {search === null || search === undefined ? null : (
        <View style={styles.search}>{search}</View>
      )}
    </View>
  );
  const toolsBand = { paddingBottom: space.s12 };

  const common = {
    title: config.title,
    testID: config.testID,
    openKey,
    onOpenChange: setOpenKey,
    added,
    onStay: (key: string) => setAdded((previous) => new Set(previous).add(key)),
    onClose,
    detailBackInHeader,
  };

  let body: React.ReactElement;
  if (registries !== null && config.sources !== undefined) {
    body = (
      <View style={styles.fill} testID={`${config.testID}:registries`}>
        {config.sources.renderRegistriesView({
          intent: registries,
          back: () => setRegistries(null),
        })}
      </View>
    );
  } else if (mode?.kind === 'input') {
    const ContainedPage = host.ContainedPage ?? PassThrough;
    const input = mode.renderBody({
      tools: (field) => (
        <View style={[toolsBand, edge]}>{tools(field ?? null)}</View>
      ),
      renderFound: (found) => (
        <AddCollection
          {...common}
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
    body =
      mode.ownsTools === true ? (
        <View style={styles.fill}>{input}</View>
      ) : (
        <View style={styles.fill}>
          <View style={[toolsBand, edge]}>{tools(null)}</View>
          <View style={styles.fill}>
            <ContainedPage>{input}</ContainedPage>
          </View>
        </View>
      );
  } else {
    // One registry failing never empties the others: each failed source keeps one quiet line with its own Retry. When
    // nothing came back at all, that line is the state, never "no results".
    const failures = catalog.sourceFailures ?? [];
    const onlyFailures =
      failures.length > 0 && catalog.items.length === 0 && !catalog.loading;
    const failureLines =
      failures.length === 0 ? null : (
        <View
          style={
            onlyFailures
              ? [{ paddingTop: space.s16 }, edge]
              : { paddingTop: space.s12 }
          }
        >
          {failures.map((failure) => (
            <host.SourceFailure
              key={failure.sourceId}
              title={failure.message}
              retryLabel={props.labels.retry}
              onRetry={failure.onRetry}
              retryTestID={`${config.testID}:sourceFailure:${failure.sourceId}:retry`}
              testID={`${config.testID}:sourceFailure:${failure.sourceId}`}
            />
          ))}
        </View>
      );
    body = (
      <AddCollection
        {...common}
        items={catalog.items}
        itemKey={catalog.itemKey}
        {...(catalog.groups === undefined ? {} : { groups: catalog.groups })}
        anatomy={catalog.anatomy}
        loading={catalog.loading}
        empty={onlyFailures ? failureLines : catalog.empty}
        search={{
          label: props.labels.searchLabel,
          value: catalog.query,
          onValueChange: catalog.onQueryChange,
          placeholder: catalog.searchPlaceholder,
          width: 'fill',
          testID: `${config.testID}:search`,
        }}
        header={(search) => (
          <>
            {tools(search)}
            {onlyFailures ? null : failureLines}
          </>
        )}
        renderDetail={config.renderDetail}
        detailFooter={config.detailFooter}
        {...(config.onAdded === undefined ? {} : { onAdded: config.onAdded })}
        footer={
          catalog.footer === undefined ? null : (
            <View
              style={[
                styles.listFooter,
                {
                  paddingVertical: space.s12,
                  borderTopColor: props.hairlineColor,
                },
                edge,
              ]}
              testID={`${config.testID}:list-footer`}
            >
              {catalog.footer}
            </View>
          )
        }
      />
    );
  }
  return <SharedContext.Provider value={shared}>{body}</SharedContext.Provider>;
}

/**
 * The body's one list + details: the public `Collection` (list, `detail: 'auto'`) at the catalog list role, its
 * header in the tools band, details beside the list (pushed on a phone) and the list's footer pinned while no details
 * are open. Browse's catalog and an input mode's results (a link's skills, an upload) both render through it.
 */
function AddCollection<Item>(
  props: Readonly<{
    title: string;
    testID: string;
    items: readonly Item[];
    itemKey: (item: Item) => string;
    groups?: HappierCapabilityAddGroups;
    anatomy: CollectionAnatomy<Item>;
    loading: boolean;
    empty: React.ReactNode;
    search?: NonNullable<CollectionProps<Item>['search']>;
    header: (search: React.ReactNode) => React.ReactNode;
    renderDetail: HappierCapabilityAddConfig<Item>['renderDetail'];
    detailFooter: HappierCapabilityAddConfig<Item>['detailFooter'];
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
  const shared = useShared();
  const { items, itemKey, openKey, onOpenChange } = props;
  const declared = props.groups;
  const groups = React.useMemo(() => {
    if (declared === undefined) return undefined;
    const groupOf = new Map<string, string>();
    for (const group of declared)
      for (const key of group.itemKeys) groupOf.set(key, group.key);
    return {
      axis: declared.map((group) => ({ key: group.key, title: group.title })),
      groupOf: (item: Item) => groupOf.get(itemKey(item)) ?? declared[0]!.key,
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
    if (openKey !== null && !props.loading && !itemsByKey.has(openKey))
      onOpenChange(null);
  }, [itemsByKey, onOpenChange, openKey, props.loading]);

  const renderDetail = (
    key: string,
    context: CollectionDetailRenderContext,
  ) => {
    const item = itemsByKey.get(key);
    if (item === undefined) return null;
    return (
      <AddDetail
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

  const Scope = shared.host.CollectionScope ?? PassThrough;
  return (
    <Scope>
      {/* The list keeps one rhythm: the same ruled rows and insets at rest, beside the details and loading. */}
      <HappierCollectionRestingRowsContext.Provider
        value={shared.phone ? 'ruled-page' : 'ruled'}
      >
        <HappierCollectionNavigationBackClosesDetailContext.Provider
          value={props.detailBackInHeader}
        >
          <View style={styles.fill}>
            <shared.host.Collection<Item>
              model={model}
              anatomy={props.anatomy}
              accessibilityLabel={props.title}
              presentation="list"
              detail="auto"
              renderDetail={renderDetail}
              minListWidth={HAPPIER_CATALOG_LIST_ROLE.minListWidthPx}
              minDetailWidth={HAPPIER_CATALOG_LIST_ROLE.minDetailWidthPx}
              preferredListRatio={HAPPIER_CATALOG_LIST_ROLE.preferredListRatio}
              loading={props.loading}
              empty={props.empty}
              {...(props.search === undefined ? {} : { search: props.search })}
              header={(slots) => (
                <ToolsBand open={openKey !== null}>
                  {props.header(slots.search)}
                </ToolsBand>
              )}
              testID={`${props.testID}:collection`}
              listTestID={`${props.testID}:list`}
              detailTestID={`${props.testID}:detail`}
            />
          </View>
        </HappierCollectionNavigationBackClosesDetailContext.Provider>
      </HappierCollectionRestingRowsContext.Provider>
      {openKey !== null ? null : props.footer}
    </Scope>
  );
}

/** The body's one content edge (the tools band, failure lines and footers stand on it): for an input mode's own parts. */
export function useHappierCapabilityAddEdge(): Readonly<{ paddingHorizontal: number }> {
  return useShared().edge;
}

/**
 * Whether the body reads as a phone page. A Collection's own layout says so for its list and details; an input mode
 * (Link, Upload, Paste) sits outside any Collection, so there the frame's phone presentation decides.
 */
function useAddBodyNarrow(): boolean {
  const layout = useHappierCollectionLayout();
  return useShared().phone || layout?.mode === 'stacked';
}

/** The modes as a tab list hugging their labels; on a phone page the glyphs step aside first, labels never truncate. */
function CatalogModes<Icon extends string>(
  props: Readonly<{
    ModeTabs: HappierCapabilityAddHost<Icon>['ModeTabs'];
    modes: readonly HappierCapabilityAddMode<Icon>[];
    activeKey: string;
    onSelect: (key: string) => void;
    testID: string;
  }>,
): React.ReactElement {
  const narrow = useAddBodyNarrow();
  const { labels } = useShared();
  const { ModeTabs } = props;
  return (
    <ModeTabs
      modes={props.modes.map((mode) => ({
        key: mode.key,
        label: mode.label,
        icon: mode.icon,
      }))}
      activeKey={props.activeKey}
      onSelect={props.onSelect}
      narrow={narrow}
      accessibilityLabel={labels.modesLabel}
      testID={props.testID}
    />
  );
}

/** The tools band; on a phone the pushed details are the page, so the band steps aside while they show. */
function ToolsBand(
  props: Readonly<{ open: boolean; children: React.ReactNode }>,
): React.ReactElement | null {
  const layout = useHappierCollectionLayout();
  const { edge, space } = useShared();
  if (props.open && layout?.mode === 'stacked') return null;
  return (
    <View style={[{ paddingBottom: space.s12 }, edge]}>{props.children}</View>
  );
}

/**
 * The pinned footer of the Add body: a quiet note (or the failure) at the start, the actions at the end. Where the
 * details are a phone page (`stacked`) the note reads on its own line and the actions share the full width. A mode that
 * is not a Collection's details (Link, Upload, Paste) is a phone page exactly when the frame is presented as one.
 */
export function HappierCapabilityAddFooter(
  props: Readonly<{
    start: React.ReactNode;
    children: React.ReactNode;
    stacked?: boolean;
    /** Placed in a `DetailsPaneFooter`, which already draws the page's edge, hairline and padding. */
    inPageFooter?: boolean;
    testID?: string;
  }>,
): React.ReactElement {
  const narrow = useAddBodyNarrow();
  const { edge: bodyEdge, space, hairlineColor } = useShared();
  const edge = props.inPageFooter ? null : bodyEdge;
  const stacked = props.stacked ?? narrow;
  const frame = props.inPageFooter
    ? [styles.row, { gap: space.s16 }]
    : [
        styles.row,
        styles.footerRule,
        {
          gap: space.s16,
          paddingVertical: space.s12,
          borderTopColor: hairlineColor,
        },
      ];
  if (stacked) {
    return (
      <View
        testID={props.testID}
        style={[...frame, styles.stacked, { gap: space.s12 }, edge]}
      >
        {props.start === null || props.start === undefined ? null : props.start}
        <View style={[styles.row, styles.stretch, { gap: space.s8 }]}>
          {React.Children.toArray(props.children).map((child, index) => (
            <View key={index} style={styles.slot}>
              {child}
            </View>
          ))}
        </View>
      </View>
    );
  }
  return (
    <View testID={props.testID} style={[...frame, edge]}>
      <View style={styles.slot}>{props.start}</View>
      {props.children}
    </View>
  );
}

function AddDetail<Item>(
  props: Readonly<{
    item: Item;
    itemKey: string;
    renderDetail: HappierCapabilityAddConfig<Item>['renderDetail'];
    detailFooter: HappierCapabilityAddConfig<Item>['detailFooter'];
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
  const { edge, space, host, labels } = useShared();
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
          : labels.addFailed,
      );
    } finally {
      setBusy(false);
    }
  }, [footer.primary, labels.addFailed, props]);
  const afterAdd = props.added ? footer.afterAdd : undefined;
  // On a phone page each after-add action takes an equal share of the row; the footer slots its children.
  const slot = (node: React.ReactNode) =>
    props.pushed ? <View style={styles.slot}>{node}</View> : node;
  const ButtonRow = host.ButtonRow ?? PassThrough;
  const primary =
    afterAdd !== undefined ? (
      <ButtonRow>
        <View
          style={[
            styles.row,
            props.pushed ? styles.slot : null,
            { gap: space.s8 },
          ]}
        >
          {afterAdd.open === undefined
            ? null
            : slot(
                <host.Button
                  title={afterAdd.open.label}
                  display="secondary"
                  onPress={() => {
                    props.onCloseDialog();
                    afterAdd.open?.onPress();
                  }}
                  testID={`${props.testID}:open-added`}
                />,
              )}
          {slot(
            <host.Button
              title={labels.done}
              display="primary"
              onPress={() => {
                props.onCloseDialog();
                afterAdd.onDone?.();
              }}
              testID={`${props.testID}:done`}
            />,
          )}
        </View>
      </ButtonRow>
    ) : (
      <host.Button
        title={props.added ? labels.added : footer.primary.label}
        display="primary"
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
    <HappierCapabilityAddFooter
      stacked={props.pushed}
      inPageFooter={props.pushed}
      start={
        error === null ? (
          (afterAdd?.start ?? footer.provenance ?? null)
        ) : (
          <host.ErrorText testID={`${props.testID}:primary-error`}>
            {error}
          </host.ErrorText>
        )
      }
    >
      {primary}
    </HappierCapabilityAddFooter>
  );
  const ContainedPage = host.ContainedPage ?? PassThrough;
  return (
    <View
      style={styles.fill}
      testID={`${props.testID}:detail:${props.itemKey}`}
    >
      {/* Pushed, the Collection leads the page with the one way back; beside the list the details close here. */}
      {props.pushed ? null : (
        <View
          style={[styles.detailClose, { top: space.s12, right: space.s12 }]}
        >
          <host.CloseDetail
            accessibilityLabel={labels.closeDetails}
            onPress={props.onCloseDetail}
            testID={`${props.testID}:close-detail`}
          />
        </View>
      )}
      <ScrollView
        style={styles.fill}
        // The details' header carries its own top space; the title row then sits level with the close button.
        contentContainerStyle={[
          { paddingTop: space.s8, paddingBottom: space.s24, gap: space.s24 },
          edge,
        ]}
      >
        <ContainedPage>
          {props.renderDetail(props.item, {
            pushed: props.pushed,
            added: props.added,
          })}
        </ContainedPage>
      </ScrollView>
      {props.pushed ? (
        <host.DetailsFooter>{footerRow}</host.DetailsFooter>
      ) : (
        footerRow
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, minHeight: 0 },
  tools: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' },
  search: { flexGrow: 1, flexBasis: 240, minWidth: 0 },
  row: { flexDirection: 'row', alignItems: 'center' },
  stacked: { flexDirection: 'column', alignItems: 'stretch' },
  stretch: { alignSelf: 'stretch' },
  slot: { flex: 1, minWidth: 0 },
  footerRule: { borderTopWidth: StyleSheet.hairlineWidth },
  listFooter: { borderTopWidth: StyleSheet.hairlineWidth },
  detailClose: { position: 'absolute', zIndex: 1 },
});

