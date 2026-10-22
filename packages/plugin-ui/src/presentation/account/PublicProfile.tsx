import { useMemo, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import type { PublicProfileReadResultV1, PublicProfileViewV1 } from '@happier-dev/plugin-sdk';

import { useHappierUiTheme } from '../../environment/context.js';
import {
  renderInertDeclarativeView,
  type InertDeclarativeLabels,
} from '../../declarative/inertDeclarativeView.js';
import { HappierText } from '../text/Text.js';
import { HappierInfoState, HappierInfoTile } from '../state/InfoState.js';
import { HAPPIER_PAGE_METRICS, HAPPIER_PUBLIC_PROFILE_HERO_METRICS } from '../layout/pageMetrics.js';
export { HAPPIER_PUBLIC_PROFILE_HERO_METRICS } from '../layout/pageMetrics.js';
import { HAPPIER_WIDGET_FRAME_METRICS, HappierWidgetFrame } from '../layout/WidgetFrame.js';
import { PublicProfileUsageBody, type HappierPublicProfileUsageHost } from './PublicProfileUsage.js';
import { projectPublicUsageChartModels, projectPublicUsageRecords, type PublicUsageChartModels } from '../usage/charts/publicUsageChartModels.js';
import type { UsageRecordsModel } from '../usage/charts/UsageWorkCharts.js';
export type { HappierPublicProfileUsageHost, HappierPublicProfileUsageLabels } from './PublicProfileUsage.js';
import {
  packWidgetGroupBands,
  resolveWidgetGroupCells,
  type WidgetGroupBand,
  type WidgetGroupCell,
} from '../layout/widgetGroupLayout.js';

type ViewWidget = Extract<
  PublicProfileViewV1['layout']['items'][number],
  { kind: 'widget' }
>;
type ViewItem = PublicProfileViewV1['layout']['items'][number];

/**
 * Every string the page shows besides the person's own data. The host localizes and formats them
 * (dates, the period, "synced 2 h ago"), so the server and the app render the same tree.
 */
export type HappierPublicProfileLabels = Readonly<{
  /** "@leeroy · Happier Cloud · since March 2026", composed from the view by the host. */
  identityLine: string;
  /** "Last 90 days". */
  periodTitle: string;
  /** "8 Jul – 5 Oct 2026 · synced 2 h ago". */
  periodDetail: string;
  /** Why visitors see nothing below the header: the owner placed no blocks. */
  emptyLayout: string;
  footerNote: string;
  report: string;
  madeWith: string;
  inert: InertDeclarativeLabels;
  /** The applied picture's credit or "Your picture · Halftone"; shown on the band. */
  heroCredit?: string;
}>;

export type HappierPublicProfileHeroGeometry = Readonly<{ bandHeightPx: number; singleColumn: boolean }>;

type PublishedPublicProfileProps = Readonly<{
  view: Omit<PublicProfileViewV1, 'appearance' | 'service' | 'urls'> & Readonly<{ urls: PublicProfileViewV1['urls'] | null }>;
  labels: HappierPublicProfileLabels;
  /**
   * The applied atmosphere band (picture or planet), painted by the host's own adapter at the given
   * geometry. Omitted for an atmosphere of None: the page keeps its name-only header.
   */
  renderHero?: (geometry: HappierPublicProfileHeroGeometry) => ReactNode;
  /** The admitted avatar or the planet mark; omitted when the owner shares neither. */
  renderAvatar?: () => ReactNode;
  /** Paint, localization and identity marks for the shared Usage bodies. */
  usage?: HappierPublicProfileUsageHost;
  /** One column: a phone host or a narrow window. Wider pages still wrap a pair that cannot fit. */
  singleColumn?: boolean;
  /**
   * The owner's own view: blocks that visitors don't see stay in place, quieted and labelled, so the
   * layout never jumps while consent changes. Visitors and the server never pass this.
   */
  owner?: HappierPublicProfileOwner;
  testID?: string;
}>;

export type HappierPublicProfileOwner = Readonly<{
  hiddenBlockIds: ReadonlySet<string>;
  onlyYou: string;
  /**
   * The owner's editable widget area in place of the projected blocks (Edit), so the page keeps its
   * header, period and footer while blocks are added, sized and arranged. Never passed to visitors.
   */
  renderBlocks?: () => ReactNode;
}>;

export type HappierPublicProfileProps = PublishedPublicProfileProps | Readonly<{
  /** Withdrawal states have no fabricated snapshot, period, coverage or applied blocks. */
  result: Exclude<PublicProfileReadResultV1, { kind: 'published' }>;
  labels: Readonly<{ paused: string; unavailable: string }>;
  testID?: string;
}>;

/**
 * The public profile page: header, one period line and the owner's placed blocks below it. One
 * tree serves the visitor page, the owner's preview and the server's cold render, so a block looks
 * the same wherever it is read. It only draws the already-projected view: hidden facts are absent
 * from `view`, never filtered here.
 */
export function HappierPublicProfile(props: HappierPublicProfileProps) {
  if ('result' in props) {
    const paused = props.result.kind === 'paused' ? props.result : null;
    return <View testID={props.testID ?? 'public-profile'} style={styles.page}>
      <View style={styles.column}>
        <HappierInfoState size="page">
          <HappierInfoTile size="page"
            title={paused ? paused.identity.name ?? `@${paused.handle}` : props.labels.unavailable}
            description={paused ? props.labels.paused : undefined} />
        </HappierInfoState>
      </View>
    </View>;
  }
  return <PublishedPublicProfile {...props} />;
}

function PublishedPublicProfile(props: PublishedPublicProfileProps) {
  const theme = useHappierUiTheme();
  const { view, labels } = props;
  const usageModels = useMemo(() => projectPublicUsageChartModels(view.snapshot, view.metadata), [view.snapshot, view.metadata]);
  const formatRecord = props.usage?.labels.records?.format;
  const usageRecords = useMemo(() => formatRecord ? projectPublicUsageRecords(view.snapshot, formatRecord) : null,
    [view.snapshot, formatRecord]);
  const testID = props.testID ?? 'public-profile';
  const columns = props.singleColumn ? 1 : 2;
  const bands = packWidgetGroupBands(
    resolveWidgetGroupCells(
      'corePage',
      view.layout.items.map((item) => ({
        id: item.id,
        size: item.kind === 'widget' ? item.size : undefined,
      })),
    ),
    columns,
  );
  const byId = new Map(
    view.layout.items.map((item) => [item.id, item] as const),
  );
  const renderCell = (cell: WidgetGroupCell) => {
    const item = byId.get(cell.id);
    return item ? (
      <PublicProfileItem
        key={item.id}
        item={item}
        labels={labels}
        usageModels={usageModels}
        usageRecords={usageRecords}
        usage={props.usage}
        owner={props.owner}
        singleColumn={columns === 1}
        testID={testID}
      />
    ) : null;
  };
  const identity = (
        <View style={[styles.identity, columns === 1 && props.renderHero ? styles.identityStacked : null]}>
          {props.renderAvatar?.()}
          <View style={styles.identityText}>
            <HappierText
              variant="display"
              tone="neutral"
              testID={`${testID}-name`}
            >
              {view.identity.name ?? `@${view.handle}`}
            </HappierText>
            <HappierText variant="meta" tone="secondary">
              {labels.identityLine}
            </HappierText>
            {view.metadata.bio ? (
              <HappierText variant="body" tone="neutral">
                {view.metadata.bio}
              </HappierText>
            ) : null}
            {view.metadata.links?.length ? (
              <View style={styles.links}>
                {view.metadata.links.map((link) => (
                  <PublicLink
                    key={link.url}
                    href={link.url}
                    label={link.label}
                    rel="me ugc nofollow noopener"
                  />
                ))}
              </View>
            ) : null}
          </View>
        </View>
  );
  return (
    <View testID={testID} style={styles.page}>
      {props.renderHero ? (
        <PublicProfileHero
          testID={testID}
          singleColumn={columns === 1}
          credit={labels.heroCredit}
          renderBand={props.renderHero}
        >
          {identity}
        </PublicProfileHero>
      ) : null}
      <View style={styles.column}>
        {props.renderHero ? null : identity}
        <View style={styles.period}>
          <HappierText variant="heading" tone="neutral">
            {labels.periodTitle}
          </HappierText>
          <HappierText variant="meta" tone="secondary" tabularNumbers>
            {labels.periodDetail}
          </HappierText>
        </View>
        {props.owner?.renderBlocks ? (
          props.owner.renderBlocks()
        ) : bands.length === 0 ? (
          <HappierText
            variant="body"
            tone="secondary"
            testID={`${testID}-empty`}
          >
            {labels.emptyLayout}
          </HappierText>
        ) : (
          <View style={styles.blocks}>
            {bands.map((band) => (
              <Band
                key={band.key}
                band={band}
                renderCell={renderCell}
              />
            ))}
          </View>
        )}
        <View style={[styles.footer, { borderTopColor: theme.colors.divider }]}>
          <HappierText
            variant="meta"
            tone="secondary"
            style={styles.footerNote}
          >
            {labels.footerNote}
          </HappierText>
          <View style={styles.footerLinks}>
            {view.urls ? <PublicLink
              href={view.urls.report}
              label={labels.report}
              testID={`${testID}-report`}
            /> : null}
            <HappierText variant="meta" tone="secondary">
              {labels.madeWith}
            </HappierText>
          </View>
        </View>
      </View>
    </View>
  );
}

/**
 * The band is reserved at its full height before any artwork paints, and the identity sits over its
 * lower edge (lab `pphero`): beside the avatar on a wide page, under it on a phone.
 */
function PublicProfileHero(
  props: Readonly<{
    testID: string;
    singleColumn: boolean;
    credit?: string;
    renderBand: (geometry: HappierPublicProfileHeroGeometry) => ReactNode;
    children: ReactNode;
  }>,
) {
  const theme = useHappierUiTheme();
  const kind = props.singleColumn ? 'phone' : 'wide';
  const bandHeightPx = HAPPIER_PUBLIC_PROFILE_HERO_METRICS.bandHeightPx[kind];
  const avatarPx = HAPPIER_PUBLIC_PROFILE_HERO_METRICS.avatarPx[kind];
  return (
    <View testID={`${props.testID}-hero`} style={styles.hero}>
      <View testID={`${props.testID}-hero-band`} style={[styles.band, styles.heroBand, { height: bandHeightPx }]}>
        {props.renderBand({ bandHeightPx, singleColumn: props.singleColumn })}
        {props.credit ? (
          <View style={[styles.credit, props.singleColumn ? styles.creditPhone : styles.creditWide,
            { backgroundColor: theme.colors.surface }]}>
            <HappierText variant="micro" tone="secondary" numberOfLines={1}>{props.credit}</HappierText>
          </View>
        ) : null}
      </View>
      <View style={[styles.column, { marginTop: -avatarPx / 2 }]}>{props.children}</View>
    </View>
  );
}

function Band(
  props: Readonly<{
    band: WidgetGroupBand;
    renderCell: (cell: WidgetGroupCell) => ReactNode;
  }>,
) {
  const { band } = props;
  if (band.kind === 'row')
    return <View style={styles.band}>{props.renderCell(band.cell)}</View>;
  if (band.kind === 'slot') return null;
  return (
    <View style={[styles.band, styles.pair]}>
      {band.columns.map((column, index) =>
        column.length ? (
          <View key={index} style={styles.pairColumn}>
            {column.map(props.renderCell)}
          </View>
        ) : null,
      )}
    </View>
  );
}

function PublicProfileItem(
  props: Readonly<{
    item: ViewItem;
    labels: HappierPublicProfileLabels;
    usageModels: PublicUsageChartModels;
    usageRecords: UsageRecordsModel | null;
    usage?: HappierPublicProfileUsageHost;
    owner?: HappierPublicProfileOwner;
    singleColumn: boolean;
    testID: string;
  }>,
) {
  const { item } = props;
  if (item.kind === 'widget')
    return (
      <PublicProfileBlock
        widget={item}
        labels={props.labels}
        usageModels={props.usageModels}
        usageRecords={props.usageRecords}
        usage={props.usage}
        owner={props.owner}
        testID={props.testID}
      />
    );
  const bands = packWidgetGroupBands(
    resolveWidgetGroupCells(
      'corePage',
      item.children.map((child) => ({ id: child.id, size: child.size })),
    ),
    props.singleColumn || item.width === 'half' ? 1 : 2,
  );
  const children = new Map(
    item.children.map((child) => [child.id, child] as const),
  );
  return (
    <HappierWidgetFrame
      frameStyle={item.frameStyle}
      placement="home"
      title={item.title ?? null}
      testID={`${props.testID}-group-${item.id}`}
    >
      {bands.map((band) => (
        <Band
          key={band.key}
          band={band}
          renderCell={(cell) => {
            const child = children.get(cell.id);
            return child ? (
              <PublicProfileBlock
                key={child.id}
                widget={child}
                labels={props.labels}
                usageModels={props.usageModels}
                usageRecords={props.usageRecords}
                usage={props.usage}
                owner={props.owner}
                testID={props.testID}
                bare
              />
            ) : null;
          }}
        />
      ))}
    </HappierWidgetFrame>
  );
}

/** The same placed block in an authenticated setup/frame; the host supplies an already masked view. */
export function HappierPublicProfileWidget(props: Readonly<{
  view: PublishedPublicProfileProps['view'];
  widgetId: string;
  labels: HappierPublicProfileLabels;
  usage?: HappierPublicProfileUsageHost;
  testID: string;
}>) {
  const models = useMemo(() => projectPublicUsageChartModels(props.view.snapshot), [props.view.snapshot]);
  const format = props.usage?.labels.records?.format;
  const records = useMemo(() => format ? projectPublicUsageRecords(props.view.snapshot, format) : null, [props.view.snapshot, format]);
  const widget = props.view.layout.items.flatMap(item => item.kind === 'widget' ? [item] : item.children)
    .find(item => item.id === props.widgetId);
  return widget ? <PublicProfileBlock widget={widget} labels={props.labels} usageModels={models} usageRecords={records}
    usage={props.usage} testID={props.testID} bare /> : null;
}

function PublicProfileBlock(
  props: Readonly<{
    widget: ViewWidget;
    labels: HappierPublicProfileLabels;
    usageModels: PublicUsageChartModels;
    usageRecords: UsageRecordsModel | null;
    usage?: HappierPublicProfileUsageHost;
    owner?: HappierPublicProfileOwner;
    testID: string;
    bare?: boolean;
  }>,
) {
  const theme = useHappierUiTheme();
  const onlyYou = props.owner?.hiddenBlockIds.has(props.widget.id) ? props.owner.onlyYou : null;
  const marker = onlyYou ? (
    <View style={[styles.onlyYou, { borderColor: theme.colors.border }]}>
      <HappierText variant="micro" tone="secondary">{onlyYou}</HappierText>
    </View>
  ) : null;
  const body = props.widget.presentation.kind === 'usage'
    ? props.usage ? <PublicProfileUsageBody presentation={props.widget.presentation} models={props.usageModels} records={props.usageRecords}
      host={props.usage} testID={`${props.testID}-usage-${props.widget.id}`} /> : null
    : renderInertDeclarativeView(props.widget.presentation.document.root, theme, props.labels.inert);
  const shownBody = onlyYou ? <View style={styles.quieted}>{body}</View> : body;
  if (props.bare)
    return (
      <View
        testID={`${props.testID}-block-${props.widget.id}`}
        style={styles.bareBlock}
      >
        {props.widget.title ? <HappierText variant="heading" tone="neutral">{props.widget.title}</HappierText> : null}
        {marker}
        {shownBody}
      </View>
    );
  return (
    <HappierWidgetFrame
      frameStyle={props.widget.frameStyle}
      placement="home"
      title={props.widget.title ?? null}
      accessory={marker}
      testID={`${props.testID}-block-${props.widget.id}`}
    >
      {shownBody}
    </HappierWidgetFrame>
  );
}

/**
 * React Native Web draws `href` as a real anchor, on the server too. The portable text props do not
 * name it, so it rides through the host Text's pass-through untyped.
 */
function anchorProps(href: string, rel: string | undefined): Record<string, unknown> {
  return { href, hrefAttrs: { rel: rel ?? 'noopener', target: '_blank' } };
}

/** A real anchor on web and in the server render; safe user links never carry an opener. */
function PublicLink(
  props: Readonly<{
    href: string;
    label: string;
    rel?: string;
    testID?: string;
  }>,
) {
  return (
    <HappierText
      variant="meta"
      tone="secondary"
      testID={props.testID}
      accessibilityRole="link"
      {...anchorProps(props.href, props.rel)}
    >
      {props.label}
    </HappierText>
  );
}

const styles = StyleSheet.create({
  page: { width: '100%' },
  hero: { width: '100%', marginBottom: HAPPIER_PAGE_METRICS.cardGapPx * 2 },
  heroBand: { position: 'relative', overflow: 'hidden' },
  credit: {
    position: 'absolute',
    right: HAPPIER_PAGE_METRICS.sheetInsetPx,
    maxWidth: '70%',
    paddingHorizontal: HAPPIER_PAGE_METRICS.pageHeaderLineGapPx * 2,
    paddingVertical: HAPPIER_PAGE_METRICS.pageHeaderLineGapPx / 2,
    borderRadius: HAPPIER_PAGE_METRICS.controlHeightPx,
  },
  creditWide: { top: HAPPIER_PAGE_METRICS.cardPaddingPx },
  // On a phone the credit stays on the picture, just above where the identity begins.
  creditPhone: { bottom: HAPPIER_PAGE_METRICS.cardPaddingPx * 3 },
  column: {
    width: '100%',
    maxWidth: HAPPIER_PAGE_METRICS.columnMaxWidthPx.wide,
    alignSelf: 'center',
    paddingHorizontal: HAPPIER_PAGE_METRICS.sheetInsetPx,
    paddingBottom: HAPPIER_PAGE_METRICS.pagePaddingBottomPx,
    gap: HAPPIER_PAGE_METRICS.cardGapPx * 2,
  },
  identity: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: HAPPIER_PAGE_METRICS.cardPaddingPx,
  },
  // On a phone the avatar sits on the band's edge and the words drop below it.
  identityStacked: { flexDirection: 'column', alignItems: 'flex-start' },
  identityText: {
    flexShrink: 1,
    minWidth: 0,
    gap: HAPPIER_PAGE_METRICS.pageHeaderLineGapPx,
  },
  links: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: HAPPIER_PAGE_METRICS.cardPaddingPx,
    rowGap: HAPPIER_PAGE_METRICS.pageHeaderLineGapPx,
  },
  period: { gap: HAPPIER_PAGE_METRICS.pageHeaderLineGapPx },
  blocks: { gap: HAPPIER_PAGE_METRICS.cardGapPx },
  band: { width: '100%' },
  // A pair wraps to one column on a narrow page without measuring, so a cold server render is responsive.
  pair: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: HAPPIER_PAGE_METRICS.cardGapPx,
  },
  pairColumn: {
    flexGrow: 1,
    // A half that would be narrower than a frame keeps its full header stacks under its pair instead.
    flexBasis: HAPPIER_WIDGET_FRAME_METRICS.sourceHiddenBelowPx,
    minWidth: 0,
    gap: HAPPIER_PAGE_METRICS.cardGapPx,
  },
  bareBlock: { minWidth: 0 },
  onlyYou: {
    alignSelf: 'flex-start',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: HAPPIER_PAGE_METRICS.controlHeightPx,
    paddingHorizontal: HAPPIER_PAGE_METRICS.pageHeaderLineGapPx * 2,
  },
  // A private block stays in place for its owner, quieted, so consent changes never move the layout.
  quieted: { opacity: 0.45 },
  footer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: HAPPIER_PAGE_METRICS.cardPaddingPx,
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: HAPPIER_PAGE_METRICS.cardGapPx,
  },
  footerNote: { flexShrink: 1 },
  footerLinks: {
    flexDirection: 'row',
    gap: HAPPIER_PAGE_METRICS.cardPaddingPx,
  },
});
