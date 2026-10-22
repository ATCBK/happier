import * as React from 'react';
import { Image, View, useWindowDimensions } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { HAPPIER_PUBLIC_PROFILE_HERO_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';
import type {
  HappierPublicProfileHeroGeometry,
  HappierPublicProfileLabels,
  HappierPublicProfileUsageHost,
} from '@happier-dev/plugin-ui/presentation';
import {
  PUBLIC_PROFILE_FIELDS_V1,
  type PublicProfilePolicyV1,
} from '@happier-dev/protocol/account/publicProfile';
import { projectPublicProfilePreview } from '@happier-dev/protocol/account/projectPublicProfile';
import { PublicProfilePreviewResultV1Schema } from '@happier-dev/protocol/account/publicProfileIntents';
import type {
  PublicProfileAppearanceV1,
  PublicProfileContextV1,
  PublicProfileLocalPreviewViewV1,
  PublicProfilePreparedAppearanceV1,
} from '@happier-dev/protocol/account/publicProfilePublication';
import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';
import { createPublicProfilePresetLayoutV1 } from '@happier-dev/protocol/widgets/publicProfileWidgetPresetsV1';
import type { BuiltinUsagePublicPresentationV1 } from '@happier-dev/protocol/widgets';

import { AtmospherePreview } from '@/components/atmosphere/look/AtmospherePreview';
import { pictureCreditLine } from '@/components/atmosphere/look/pictureCredit';
import { useAtmospherePictureCatalog } from '@/components/atmosphere/useAtmospherePictureCatalog';
import { LookPopover } from '@/components/atmosphere/look/LookChip';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import {
  usageCrewLabels,
  usageOrbitLabels,
  usagePlanetLabels,
  usageShippedLabels,
  usageSkyLabels,
} from '@/components/settings/usage/widgets/usageChartLabels';
import { useUsageChartHost } from '@/components/settings/usage/widgets/usageChartHost';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Modal } from '@/modal';
import type { CustomModalInjectedProps } from '@/modal/types';
import {
  formatUsageCalendarDate,
  formatUsageCalendarPeriod,
} from '@/sync/domains/usage/usageCalendarPresentation';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { t } from '@/text';
import { formatRelativeTime } from '@/utils/time/formatShortRelativeTime';
import { useAccountEncryptionMode } from '../useAccountEncryptionMode';
import {
  PublicProfileEditor,
  type PublicProfileEditorView,
} from './PublicProfileEditor';
import {
  PublicProfileLookPanel,
  usePreparePublicProfileLook,
} from './PublicProfileLookPanel';
import { PublicProfilePublicData } from './PublicProfilePublicData';
import { PublicProfileReview } from './PublicProfileReview';
import {
  createPublicProfileDraft,
  draftLookPresentation,
  resolvePublicFieldPlacements,
  resolvePublicProfileDraftChanges,
  setPublicProfileDraftField,
  type PublicProfileDraft,
} from './publicProfileDraft';
import { publicProfileMutationNotice } from './publicProfileMutation';
import { usePublicProfileOwnerRead } from './usePublicProfileOwnerRead';

/** The owner's own values for every item: computed locally, never uploaded or published. */
const OWNER_POLICY: PublicProfilePolicyV1 = {
  indexable: false,
  fields: Object.fromEntries(
    PUBLIC_PROFILE_FIELDS_V1.map((field) => [field, true]),
  ) as PublicProfilePolicyV1['fields'],
};
const DEFAULT_QUERY = { period: { relative: '90days' } } as const;
const BLOCK_TITLE_KEYS = {
  usage_rhythm: 'sky',
  usage_breakdowns: 'crew',
  usage_planet: 'planet',
  usage_orbit: 'orbit',
  usage_outcomes: 'shipped',
} as const;

function blockTitle(
  presentation: BuiltinUsagePublicPresentationV1,
): string | undefined {
  const key =
    BLOCK_TITLE_KEYS[presentation.widgetId as keyof typeof BLOCK_TITLE_KEYS];
  return key ? t(`publicIdentity.blocks.${key}`) : undefined;
}

function blockIds(view: PublicProfileEditorView | null): ReadonlySet<string> {
  return new Set(
    view?.layout.items.flatMap((item) =>
      item.kind === 'widget'
        ? [item.id]
        : item.children.map((child) => child.id),
    ) ?? [],
  );
}

function withoutAppearance(
  view: PublicProfileLocalPreviewViewV1,
): PublicProfileEditorView {
  const { appearance: _appearance, ...rest } = view;
  return rest;
}

/**
 * What the preview needs to compile the page. The band is drawn locally from the draft, so a picture
 * is prepared only at review time; the preview itself never carries pixels.
 */
function previewAppearance(
  draft: PublicProfileDraft,
  applied: PublicProfilePreparedAppearanceV1 | null,
): PublicProfilePreparedAppearanceV1 {
  if (draft.appearance.kind === 'applied')
    return applied ?? { atmosphere: { source: 'none' }, theme: 'auto' };
  const atmosphere = draft.appearance.atmosphere;
  return {
    theme: draft.appearance.theme,
    atmosphere:
      atmosphere.source === 'planet'
        ? { source: 'planet', planet: atmosphere.planet }
        : { source: 'none' },
  };
}

/**
 * Settings → Account → Public profile → Edit: the owner's page with Edit and Preview, Public data,
 * Look, and one reviewed Publish or Apply. Everything is a private draft until that review.
 */
export function PublicProfileEditorScreen(): React.ReactElement {
  const scope = useAccountSettingsScope();
  const execution = useMountedActionExecution(scope);
  const serverId = scope?.serverId ?? '';
  const { state, reload } = usePublicProfileOwnerRead(execution);
  const read = state.kind === 'ready' ? state.read : null;
  const record = read?.kind === 'ready' ? read.record : null;
  const context = read?.context ?? null;
  const encryption = useAccountEncryptionMode();
  const { width } = useWindowDimensions();
  const singleColumn = width < HAPPIER_PUBLIC_PROFILE_HERO_METRICS.singleColumnBelowWidthPx;
  const [draft, setDraft] = React.useState<PublicProfileDraft | null>(null);
  const [mode, setMode] = React.useState<'edit' | 'preview'>('edit');
  const [snapshotView, setSnapshotView] =
    React.useState<PublicProfileLocalPreviewViewV1 | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [panel, setPanel] = React.useState<'look' | 'publicData' | null>(null);
  const lookAnchor = React.useRef<View>(null);
  const dataAnchor = React.useRef<View>(null);
  const prepareLook = usePreparePublicProfileLook(serverId);

  // The first read seeds the draft once; later reads (after Apply) reseed from the new edition.
  const seeded = React.useRef<unknown>(null);
  React.useEffect(() => {
    if (!read || seeded.current === read) return;
    seeded.current = read;
    setDraft(
      createPublicProfileDraft(record, {
        layout: createPublicProfilePresetLayoutV1('minimal', {
          title: blockTitle,
        }),
      }),
    );
  }, [read, record]);

  const query = record?.query ?? DEFAULT_QUERY;
  const recordAppearance = record?.appearance ?? null;
  const appliedAppearance = React.useMemo<PublicProfilePreparedAppearanceV1 | null>(() => {
    // A planet or none look is its own prepared form; an applied picture has no local pixels.
    const atmosphere = recordAppearance?.atmosphere;
    if (!recordAppearance || !atmosphere || atmosphere.source === 'picture') return null;
    return { theme: recordAppearance.theme,
      atmosphere: atmosphere.source === 'planet' ? { source: 'planet', planet: atmosphere.planet } : { source: 'none' } };
  }, [recordAppearance]);

  // One local preview with every item gives the owner's own values; visitors are projected from it.
  // The snapshot depends only on the period; blocks, consent and look are compiled locally from it,
  // so editing the page never re-reads Usage. The latest callbacks are read without restarting.
  const latest = React.useRef({ executeValue: execution.executeValue, draft, appliedAppearance });
  latest.current = { executeValue: execution.executeValue, draft, appliedAppearance };
  const { ready } = execution;
  const queryKey = JSON.stringify(query);
  const hasDraft = draft !== null;
  const [attempt, setAttempt] = React.useState(0);
  React.useEffect(() => {
    const { draft: seed } = latest.current;
    if (!ready || !seed) return;
    let current = true;
    setNotice(null);
    void (async () => {
      try {
        const result = PublicProfilePreviewResultV1Schema.parse(
          await latest.current.executeValue('account.public_profile.preview', {
            policy: OWNER_POLICY,
            metadataSelection: {},
            query: JSON.parse(queryKey),
            layout: seed.layout,
            appearance: previewAppearance(seed, latest.current.appliedAppearance),
          }),
        );
        if (!current) return;
        if (result.kind === 'ready') setSnapshotView(result.view);
        else setNotice(t(`publicIdentity.profile.reasons.${result.reason}`));
      } catch {
        if (current) setNotice(t('publicIdentity.profile.loadFailedBody'));
      }
    })();
    return () => {
      current = false;
    };
  }, [ready, queryKey, hasDraft, attempt]);

  const views = React.useMemo(() => {
    if (!snapshotView || !draft || !context) return null;
    const project = (policy: PublicProfilePolicyV1) => {
      const view = projectPublicProfilePreview({
        context,
        policy,
        metadata: {},
        snapshot: snapshotView.snapshot,
        layout: draft.layout,
        appearance: previewAppearance(draft, appliedAppearance),
      });
      return view ? withoutAppearance(view) : null;
    };
    const owner = project(OWNER_POLICY);
    const visitor = project(draft.policy);
    const visible = blockIds(visitor);
    return {
      owner,
      visitor,
      hidden: new Set([...blockIds(owner)].filter((id) => !visible.has(id))),
      placements: resolvePublicFieldPlacements({
        context,
        snapshot: snapshotView.snapshot,
        draft,
      }),
    };
  }, [snapshotView, draft, context, appliedAppearance]);

  const changes = draft
    ? resolvePublicProfileDraftChanges(record, draft)
    : null;
  const changeCount = changes
    ? Number(changes.policy) +
      Number(changes.layout) +
      Number(changes.appearance)
    : 0;
  const usage = usePublicProfileUsageHost(
    serverId,
    snapshotView?.snapshot.period.timeZoneOffsetMinutes ?? 0,
  );
  const pictures = useAtmospherePictureCatalog();
  const lookPresentation = draft ? draftLookPresentation(draft, record?.appearance ?? null) : null;
  const pictureRef = lookPresentation?.source === 'picture' ? lookPresentation.picture.ref : null;
  const creditPicture = pictureRef?.kind === 'builtin' ? pictures.find(picture => picture.id === pictureRef.id) : undefined;
  const labels =
    context && snapshotView
      ? publicProfilePageLabels(context, snapshotView, creditPicture ? pictureCreditLine(creditPicture) : null)
      : null;

  const submit = React.useCallback(async () => {
    if (!draft || !context?.service) return;
    const publishing = !record || record.state === 'draft';
    let appearance: PublicProfilePreparedAppearanceV1 | undefined;
    if (draft.appearance.kind === 'candidate') {
      const prepared = await prepareLook({
        serverId,
        value: draft.appearance.atmosphere,
      });
      if (prepared.status !== 'ready') {
        setNotice(
          t(
            prepared.reason === 'account_retired'
              ? 'publicIdentity.profile.reasons.preparation_unavailable'
              : 'publicIdentity.profile.reasons.asset_unavailable',
          ),
        );
        return;
      }
      appearance = {
        atmosphere: prepared.prepared,
        theme: draft.appearance.theme,
      };
    }
    const shared = PUBLIC_PROFILE_FIELDS_V1.filter(
      (field) => draft.policy.fields[field],
    );
    Modal.show({
      component: PublicProfileReviewModal,
      props: {
        kind: publishing ? 'publish' : 'apply',
        service: context.service.displayName,
        sharedFields: shared,
        endToEndEncrypted: encryption === 'e2ee',
        uploadsPicture: appearance?.atmosphere.source === 'picture',
        indexable: draft.policy.indexable,
        confirm: async () => {
          setSubmitting(true);
          setNotice(null);
          try {
            const changed = resolvePublicProfileDraftChanges(record, draft);
            const outcome = publishing
              ? await execution.execute('account.public_profile.publish', {
                  intent: 'publish',
                  policy: draft.policy,
                  metadataSelection: {},
                  query,
                  layout: draft.layout,
                  appearance:
                    appearance ?? previewAppearance(draft, appliedAppearance),
                })
              : await execution.execute('account.public_profile.update', {
                  ...(changed.policy ? { policy: draft.policy } : {}),
                  ...(changed.layout ? { layout: draft.layout } : {}),
                  ...(appearance ? { appearance } : {}),
                });
            if (!outcome.ok) {
              if (!isActionApprovalDeclinedErrorCode(outcome.errorCode))
                setNotice(t('publicIdentity.profile.actionFailed'));
              return;
            }
            setNotice(
              publicProfileMutationNotice(outcome.result) ??
                (publishing
                  ? t('publicIdentity.editor.published')
                  : t('publicIdentity.editor.applied')),
            );
            await reload();
          } catch {
            setNotice(t('publicIdentity.profile.actionUncertain'));
            await reload();
          } finally {
            setSubmitting(false);
          }
        },
      },
      chrome: {
        kind: 'card',
        phonePresentation: 'sheet',
        testID: 'public-profile-review-modal',
        title: publishing
          ? t('publicIdentity.review.titlePublish')
          : t('publicIdentity.review.titleApply'),
      },
      closeOnBackdrop: true,
    });
  }, [
    draft,
    context,
    record,
    prepareLook,
    serverId,
    encryption,
    execution,
    query,
    appliedAppearance,
    reload,
  ]);

  const header = (
    <SettingsPageHeader
      title={t('publicIdentity.editor.title')}
      description={t('publicIdentity.profile.purposeIntro')}
    />
  );
  if (state.kind === 'failed') {
    return (
      <ItemList style={{ paddingTop: 0 }}>
        {header}
        <SurfaceStateCard
          kind="error"
          title={t('publicIdentity.profile.loadFailedTitle')}
          reason={t('publicIdentity.profile.loadFailedBody')}
          action={{ label: t('publicIdentity.profile.retry'), onPress: reload }}
          replacesContent
        />
      </ItemList>
    );
  }
  const renderBand = draft
    ? profileBand(draft, record?.appearance ?? null, context)
    : undefined;
  return (
    <ItemList style={{ paddingTop: 0 }}>
      {header}
      {draft && labels ? (
        <PublicProfileEditor
          status={record?.state ?? 'draft'}
          mode={mode}
          onModeChange={setMode}
          changes={changeCount}
          ownerView={views?.owner ?? null}
          visitorView={views?.visitor ?? null}
          hiddenBlockIds={views?.hidden ?? new Set()}
          pageLabels={labels}
          usage={usage}
          renderBand={renderBand}
          singleColumn={singleColumn}
          notice={notice}
          submitting={submitting}
          onSubmit={() => {
            void submit();
          }}
          renderTools={() => (
            <>
              <View ref={lookAnchor} collapsable={false}>
                <RoundButton
                  testID="public-profile-editor-look"
                  size="small"
                  display="secondary"
                  title={t('publicIdentity.editor.look')}
                  onPress={() => setPanel('look')}
                />
              </View>
              <View ref={dataAnchor} collapsable={false}>
                <RoundButton
                  testID="public-profile-editor-public-data"
                  size="small"
                  display="secondary"
                  title={t('publicIdentity.editor.publicData')}
                  onPress={() => setPanel('publicData')}
                />
              </View>
              <LookPopover
                open={panel === 'look'}
                anchorRef={lookAnchor}
                onRequestClose={() => setPanel(null)}
              >
                <PublicProfileLookPanel
                  serverId={serverId}
                  value={draftLookPresentation(draft, record?.appearance ?? null)}
                  onChange={(atmosphere) =>
                    setDraft((current) =>
                      current
                        ? {
                            ...current,
                            appearance: {
                              kind: 'candidate',
                              atmosphere,
                              theme:
                                current.appearance.kind === 'candidate'
                                  ? current.appearance.theme
                                  : (record?.appearance?.theme ?? 'auto'),
                            },
                          }
                        : current,
                    )
                  }
                />
              </LookPopover>
              <LookPopover
                open={panel === 'publicData'}
                anchorRef={dataAnchor}
                onRequestClose={() => setPanel(null)}
                accessibilityLabel={t('publicIdentity.publicData.title')}
              >
                <PublicProfilePublicData
                  policy={draft.policy}
                  placements={views?.placements ?? null}
                  onToggle={(field, shown) =>
                    setDraft((current) =>
                      current
                        ? setPublicProfileDraftField(current, field, shown)
                        : current,
                    )
                  }
                />
              </LookPopover>
            </>
          )}
        />
      ) : draft && notice ? (
        // The page cannot be prepared on this device right now: say why, keep the draft, offer a retry.
        <SurfaceStateCard
          testID="public-profile-editor-unavailable"
          kind="unavailable"
          title={t('publicIdentity.profile.unavailableTitle')}
          reason={notice}
          action={{ label: t('publicIdentity.profile.retry'), onPress: () => setAttempt(value => value + 1) }}
          replacesContent
        />
      ) : (
        <SurfaceStateCard
          testID="public-profile-editor-loading"
          kind="loading"
          title={t('publicIdentity.editor.preparing')}
          replacesContent
        />
      )}
    </ItemList>
  );
}

function profileBand(draft: PublicProfileDraft, applied: PublicProfileAppearanceV1 | null, context: PublicProfileContextV1 | null)
  : ((geometry: HappierPublicProfileHeroGeometry) => React.ReactNode) | undefined {
  if (draft.appearance.kind === 'applied' && applied?.atmosphere.source === 'picture') {
    // The applied picture is the reviewed public copy; the owner sees exactly what visitors get.
    const page = context?.urls?.page;
    return page ? geometry => <Image accessibilityIgnoresInvertColors source={{ uri: `${page}/background` }}
      style={[styles.band, { height: geometry.bandHeightPx }]} resizeMode="cover" /> : undefined;
  }
  const presentation = draftLookPresentation(draft, applied);
  if (presentation.source === 'none') return undefined;
  const target = { publicProfile: presentation };
  return geometry => <View style={[styles.band, { height: geometry.bandHeightPx }]}><AtmospherePreview target={target} frame="band" /></View>;
}

function publicProfilePageLabels(
  context: PublicProfileContextV1,
  view: PublicProfileLocalPreviewViewV1,
  credit: string | null,
): HappierPublicProfileLabels {
  const period = view.snapshot.period;
  const since =
    context.identity.sinceMs === undefined
      ? null
      : formatUsageCalendarDate(
          context.identity.sinceMs,
          period.timeZoneOffsetMinutes,
          { month: 'long', year: 'numeric' },
        );
  return {
    identityLine: [
      context.handle ? `@${context.handle}` : null,
      context.service?.displayName ?? null,
      since ? t('publicIdentity.page.since', { date: since }) : null,
    ]
      .filter(Boolean)
      .join(' · '),
    periodTitle: formatUsageCalendarPeriod({ relative: '90days' }),
    periodDetail: t('publicIdentity.page.periodDetail', {
      range: formatUsageCalendarPeriod(period),
      synced: formatRelativeTime(view.snapshot.computedAtMs),
    }),
    emptyLayout: t('publicIdentity.page.empty'),
    footerNote: t('publicIdentity.page.footerNote'),
    report: t('publicIdentity.page.report'),
    madeWith: t('publicIdentity.page.madeWith'),
    inert: {
      success: t('publicIdentity.page.success'),
      warning: t('publicIdentity.page.warning'),
      error: t('publicIdentity.page.error'),
      incomplete: t('publicIdentity.page.incomplete'),
    },
    ...(credit ? { heroCredit: credit } : {}),
  };
}

/** The same chart host and wording as private Usage, read against the public snapshot's calendar. */
function usePublicProfileUsageHost(
  serverId: string,
  timeZoneOffsetMinutes: number,
): HappierPublicProfileUsageHost {
  const host = useUsageChartHost(serverId);
  return React.useMemo(() => {
    const query = { timeZoneOffsetMinutes };
    return {
      paint: host.paint,
      agent: host.agent,
      renderPlanet: host.renderPlanet,
      labels: {
        chartLabel: (widgetId) => t(`usage.widgets.${widgetId}`),
        unavailable: t('publicIdentity.page.blockUnavailable'),
        sky: usageSkyLabels({
          query,
          metricName: t('publicIdentity.page.activityLevel'),
          formatValue: (value) => String(value),
          colourBy: 'intensity',
        }),
        crew: usageCrewLabels(null),
        orbit: usageOrbitLabels(),
        planet: usagePlanetLabels(),
        shipped: usageShippedLabels(query, 'accent'),
      },
    };
  }, [host.paint, host.agent, host.renderPlanet, timeZoneOffsetMinutes]);
}

function PublicProfileReviewModal(
  props: CustomModalInjectedProps &
    Readonly<{
      kind: 'publish' | 'apply';
      service: string;
      sharedFields: readonly (typeof PUBLIC_PROFILE_FIELDS_V1)[number][];
      endToEndEncrypted: boolean;
      uploadsPicture: boolean;
      indexable: boolean;
      confirm: () => Promise<void>;
    }>,
) {
  const [confirming, setConfirming] = React.useState(false);
  return (
    <PublicProfileReview
      kind={props.kind}
      service={props.service}
      sharedFields={props.sharedFields}
      endToEndEncrypted={props.endToEndEncrypted}
      uploadsPicture={props.uploadsPicture}
      indexable={props.indexable}
      confirming={confirming}
      onCancel={props.onClose}
      onConfirm={() => {
        setConfirming(true);
        void props.confirm().finally(props.onClose);
      }}
    />
  );
}

const styles = StyleSheet.create(() => ({
  band: { width: '100%' },
}));
