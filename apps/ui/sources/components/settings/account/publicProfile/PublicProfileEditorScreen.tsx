import * as React from 'react';
import { View, useWindowDimensions } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { HAPPIER_PUBLIC_PROFILE_HERO_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';
import type {
  HappierPublicProfileHeroGeometry,
} from '@happier-dev/plugin-ui/presentation';
import {
  PUBLIC_PROFILE_FIELDS_V1,
  type PublicProfilePolicyV1,
} from '@happier-dev/protocol/account/publicProfile';
import { projectPublicProfilePreview } from '@happier-dev/protocol/account/projectPublicProfile';
import { PublicProfilePreviewResultV1Schema, type PublicProfilePreparationUnavailableReasonV1 } from '@happier-dev/protocol/account/publicProfileIntents';
import type {
  PublicProfileAppearanceV1,
  PublicProfileContextV1,
  PublicProfileLocalPreviewViewV1,
  PublicProfilePreparedAppearanceV1,
} from '@happier-dev/protocol/account/publicProfilePublication';
import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { BuiltinUsagePublicPresentationV1 } from '@happier-dev/protocol/widgets';

import { AtmospherePreview, PublicPictureBand } from '@/components/atmosphere/look/AtmospherePreview';
import { pictureCreditLine } from '@/components/atmosphere/look/pictureCredit';
import { useAtmospherePictureCatalog } from '@/components/atmosphere/useAtmospherePictureCatalog';
import { LookPopover } from '@/components/atmosphere/look/LookChip';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Modal } from '@/modal';
import type { CustomModalInjectedProps } from '@/modal/types';
import {
  formatUsageCalendarPeriod,
} from '@/sync/domains/usage/usageCalendarPresentation';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { t } from '@/text';
import { useAccountEncryptionMode } from '../useAccountEncryptionMode';
import {
  PublicProfileEditor,
  type PublicProfileEditorView,
} from './PublicProfileEditor';
import {
  PublicProfileLookPanel,
  usePreparePublicProfileLook,
} from './PublicProfileLookPanel';
import { PublicProfileConsentStatus } from './PublicProfileConsentStatus';
import { PublicProfilePublicData } from './PublicProfilePublicData';
import { PublicProfileReview } from './PublicProfileReview';
import { preparedPictureCopy, useAppliedPictureCopy } from './publicPictureCopy';
import {
  createPublicProfileDraft,
  DEFAULT_PUBLIC_PROFILE_QUERY,
  draftLookPresentation,
  resolvePublicFieldPlacements,
  resolvePublicProfileDraftChanges,
  type PublicProfileDraft,
} from './publicProfileDraft';
import { publicProfileMutationNotice } from './publicProfileMutation';
import { usePublicProfileOwnerRead } from './usePublicProfileOwnerRead';
import { usePublicProfileWidgetArea } from './usePublicProfileWidgetArea';
import { PublicProfileWidgetArea, publicProfilePresetNames, usePublicProfileUsageContext } from './PublicProfileWidgetArea';
import { usePublicProfileConsent } from './usePublicProfileConsent';
import { publicProfilePageLabels, usePublicProfileUsageHost } from './publicProfilePresentation';
import { PublicProfileWidgetPreviewContext, type PublicProfileWidgetPreview } from './PublicProfileWidgetSurface';

/** The owner's own values for every item: computed locally, never uploaded or published. */
const OWNER_POLICY: PublicProfilePolicyV1 = {
  indexable: false,
  fields: Object.fromEntries(
    PUBLIC_PROFILE_FIELDS_V1.map((field) => [field, true]),
  ) as PublicProfilePolicyV1['fields'],
};
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
 * Look, and one reviewed Publish or Apply. Published consent has its own acknowledged update.
 */
export function PublicProfileEditorScreen(): React.ReactElement {
  const scope = useAccountSettingsScope();
  return <CapturedPublicProfileEditorScreen key={JSON.stringify(scope)} scope={scope} />;
}

/** Private snapshot, consent and Look memory belong to the captured publishing Account. */
function CapturedPublicProfileEditorScreen({ scope }: Readonly<{ scope: ReturnType<typeof useAccountSettingsScope> }>): React.ReactElement {
  const execution = useMountedActionExecution(scope);
  const serverId = scope?.serverId ?? '';
  const { state, reload, acknowledge } = usePublicProfileOwnerRead(execution);
  const read = state.kind === 'ready' ? state.read : null;
  const record = read?.kind === 'ready' ? read.record : null;
  const context = read?.context ?? null;
  const encryption = useAccountEncryptionMode();
  const { width } = useWindowDimensions();
  const singleColumn = width < HAPPIER_PUBLIC_PROFILE_HERO_METRICS.singleColumnBelowWidthPx;
  const [privateDraft, setDraft] = React.useState<PublicProfileDraft | null>(null);
  // Placed widgets read the page's own public period, as visitors' numbers do.
  const recordPeriod = record?.query?.period;
  const areaPeriod = recordPeriod && 'relative' in recordPeriod && recordPeriod.relative ? recordPeriod.relative : DEFAULT_PUBLIC_PROFILE_QUERY.period.relative;
  const areaUsage = usePublicProfileUsageContext(areaPeriod);
  const presetNames = React.useMemo(publicProfilePresetNames, []);
  const widgetArea = usePublicProfileWidgetArea(serverId, execution, blockTitle, areaUsage.context, presetNames);
  const draft = React.useMemo(() => privateDraft && widgetArea.candidate
    ? { ...privateDraft, layout: widgetArea.candidate.layout } : privateDraft, [privateDraft, widgetArea.candidate?.layout]);
  const [mode, setMode] = React.useState<'edit' | 'preview'>('edit');
  const [snapshotView, setSnapshotView] =
    React.useState<PublicProfileLocalPreviewViewV1 | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  // Why the page's own Usage preview is missing: said once, on the page's period line.
  const [previewReason, setPreviewReason] = React.useState<PublicProfilePreparationUnavailableReasonV1 | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [panel, setPanel] = React.useState<'look' | 'publicData' | null>(null);
  const lookAnchor = React.useRef<View>(null);
  const dataAnchor = React.useRef<View>(null);
  const prepareLook = usePreparePublicProfileLook(serverId);
  const consent = usePublicProfileConsent({ record, draft, setDraft, execution, onAcknowledged: acknowledge });

  // Consent acknowledgements preserve private placement/Look edits. Only Apply reseeds the edition.
  const seeded = React.useRef(false);
  React.useEffect(() => {
    if (!read || seeded.current) return;
    seeded.current = true;
    setDraft(
      createPublicProfileDraft(record, {
        layout: { v: 1, items: [] },
      }),
    );
  }, [read, record]);

  const query = record?.query ?? DEFAULT_PUBLIC_PROFILE_QUERY;
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
    if (!ready || !hasDraft || !seed) return;
    let current = true;
    setPreviewReason(null);
    void (async () => {
      try {
        const result = PublicProfilePreviewResultV1Schema.parse(
          await latest.current.executeValue('account.public_profile.preview', {
            policy: OWNER_POLICY,
            metadataSelection: {},
            query: JSON.parse(queryKey),
            // Facts are independent of placement; composing the private area never re-queries Usage.
            layout: { v: 1, items: [] },
            appearance: previewAppearance(seed, latest.current.appliedAppearance),
          }),
        );
        if (!current) return;
        if (result.kind === 'ready') setSnapshotView(result.view);
        else setPreviewReason(result.reason);
      } catch {
        if (current) setPreviewReason('preparation_unavailable');
      }
    })();
    return () => {
      current = false;
    };
  }, [ready, queryKey, hasDraft, attempt]);

  // Revocation never requires unlocked/fresh Usage: the acknowledged public snapshot is sufficient.
  const previewSnapshot = snapshotView?.snapshot ?? record?.snapshot ?? null;
  const views = React.useMemo(() => {
    if (!previewSnapshot || !draft || !context) return null;
    const project = (policy: PublicProfilePolicyV1) => {
      const view = projectPublicProfilePreview({
        context,
        policy,
        metadata: {},
        snapshot: previewSnapshot,
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
        snapshot: previewSnapshot,
        draft,
      }),
    };
  }, [previewSnapshot, draft, context, appliedAppearance]);

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
    previewSnapshot?.period ?? null,
  );
  const pictures = useAtmospherePictureCatalog();
  const lookPresentation = draft ? draftLookPresentation(draft, record?.appearance ?? null) : null;
  const pictureRef = lookPresentation?.source === 'picture' ? lookPresentation.picture.ref : null;
  const creditPicture = pictureRef?.kind === 'builtin' ? pictures.find(picture => picture.id === pictureRef.id) : undefined;
  const credit = creditPicture ? pictureCreditLine(creditPicture) : null;
  const awaitingReason = previewReason ? t(`publicIdentity.profile.reasons.${previewReason}`) : t('publicIdentity.editor.preparing');
  const labels = React.useMemo(() => context ? publicProfilePageLabels(context, previewSnapshot, credit) : null,
    [context, previewSnapshot, credit]);
  // Until the page has its own preview, it is still this person's page: their name, handle and band.
  const shellView = React.useMemo(() => context?.handle ? {
    v: 1 as const, handle: context.handle, indexable: false, state: 'published' as const, identity: context.identity,
    metadata: {}, snapshot: null, layout: { v: 1 as const, items: [] }, urls: context.urls,
  } : null, [context]);
  const widgetPreview = React.useMemo<PublicProfileWidgetPreview | null>(() => !(context && draft && labels) ? null
    : !previewSnapshot ? { kind: 'unavailable', reason: awaitingReason } : {
    kind: 'ready',
    source: { context, policy: mode === 'edit' ? OWNER_POLICY : draft.policy, metadata: {}, snapshot: previewSnapshot,
      appearance: previewAppearance(draft, appliedAppearance) },
    labels, usage,
  }, [context, previewSnapshot, draft, labels, mode, appliedAppearance, usage, awaitingReason]);

  const appliedPicture = record?.appearance?.atmosphere.source === 'picture' ? record.appearance.atmosphere.picture : null;
  const appliedPictureData = useAppliedPictureCopy(
    appliedPicture && context?.urls?.page ? `${context.urls.page}/background` : null,
    appliedPicture?.ref.id ?? null,
  );

  const submit = React.useCallback(async () => {
    const candidate = widgetArea.candidate;
    if (!draft || !context?.service) return;
    if (!candidate?.isCurrent()) {
      setNotice(t('publicIdentity.profile.reasons.preparation_unavailable'));
      return;
    }
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
    if (!candidate.isCurrent()) return;
    const review = (disclosure: PublicProfileEditorView | null,
      policy: PublicProfilePolicyV1, prepared: PublicProfilePreparedAppearanceV1,
      period: string, reviewContext: PublicProfileContextV1 = context): Promise<boolean> => {
      const service = reviewContext.service;
      if (!service || !candidate.isCurrent() || !execution.isCurrent()) return Promise.resolve(false);
      const picture = prepared.atmosphere.source === 'picture' ? prepared.atmosphere.picture : null;
      const pictureCopy = picture ? preparedPictureCopy(picture) : null;
      const signal = execution.getSignal();
      return new Promise(resolve => {
        let settled = false;
        let modalId: string;
        const finish = (confirmed: boolean) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', abort);
          const current = candidate.isCurrent() && execution.isCurrent();
          if (confirmed && !current) setNotice(t('publicIdentity.profile.reasons.preparation_unavailable'));
          resolve(confirmed && current && !signal.aborted);
        };
        const abort = () => { finish(false); Modal.hide(modalId); };
        if (signal.aborted) { resolve(false); return; }
        modalId = Modal.show({
          component: PublicProfileReviewModal,
          props: {
            kind: publishing ? 'publish' : 'apply', service: service.displayName,
            pageUrl: reviewContext.urls?.page ?? null, period,
            sharedFields: PUBLIC_PROFILE_FIELDS_V1.filter(field => policy.fields[field]),
            disclosure, preparationReason: !disclosure ? previewReason : null,
            ...(picture && pictureCopy
              ? { renderPicture: () => <ReviewPictureBand picture={picture} data={pictureCopy.data} copyId={pictureCopy.copyId} /> }
              : {}),
            endToEndEncrypted: encryption === 'e2ee', indexable: policy.indexable,
            confirm: async () => { finish(true); }, cancel: () => finish(false),
          },
          onRequestClose: () => finish(false), onHostUnmount: () => finish(false),
          chrome: { kind: 'card', phonePresentation: 'sheet', testID: 'public-profile-review-modal',
            title: publishing ? t('publicIdentity.review.titlePublish') : t('publicIdentity.review.titleApply') },
          closeOnBackdrop: true,
        });
        signal.addEventListener('abort', abort, { once: true });
      });
    };
    setSubmitting(true);
    setNotice(null);
    try {
      const changed = resolvePublicProfileDraftChanges(record, draft);
      const preparedAppearance = appearance ?? previewAppearance(draft, appliedAppearance);
      const outcome = publishing
        ? await execution.execute('account.public_profile.publish', {
            intent: 'publish', policy: draft.policy, metadataSelection: {}, query,
            layout: draft.layout, appearance: preparedAppearance,
          }, {
            // Canonical preparation happens once before F2. Ask and dispatch retain
            // that exact effect; neither may silently reread different Usage facts.
            reviewPublicProfilePreparedAction: async effect => {
              if (effect.request.operation !== 'publish') return false;
              const body = effect.request.body;
              const view = projectPublicProfilePreview({ context: effect.publicationContext, policy: body.policy,
                metadata: body.metadata, snapshot: body.snapshot, layout: body.layout, appearance: body.appearance });
              return view ? review(withoutAppearance(view), body.policy, body.appearance,
                formatUsageCalendarPeriod(body.snapshot.period), effect.publicationContext) : false;
            },
          })
        : await review(views?.visitor ?? null, draft.policy, preparedAppearance,
            formatUsageCalendarPeriod(snapshotView?.snapshot.period ?? query.period))
          ? await execution.execute('account.public_profile.update', {
              ...(changed.layout ? { layout: draft.layout } : {}), ...(appearance ? { appearance } : {}),
            }) : null;
      if (!outcome) return;
      if (!outcome.ok) {
        if (!isActionApprovalDeclinedErrorCode(outcome.errorCode)) setNotice(publicProfileMutationNotice(outcome));
        return;
      }
      setNotice(publicProfileMutationNotice(outcome.result) ??
        (publishing ? t('publicIdentity.editor.published') : t('publicIdentity.editor.applied')));
      seeded.current = false;
      await reload();
    } catch {
      setNotice(t('publicIdentity.profile.actionUncertain'));
      await reload();
    } finally {
      setSubmitting(false);
    }
  }, [
    widgetArea.candidate,
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
    snapshotView,
    views,
  ]);

  if (state.kind === 'failed') {
    return (
      <ItemList style={{ paddingTop: 0 }}>
        <SettingsPageHeader title={t('publicIdentity.editor.title')} />
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
    ? profileBand(draft, record?.appearance ?? null, appliedPictureData)
    : undefined;
  const consentStatus = (
    <PublicProfileConsentStatus
      state={consent.state}
      onUndo={() => { void consent.undo(); }}
      onRetry={(field, shown) => { void consent.updateField(field, shown); }}
      onCheck={() => { void reload(); }}
    />
  );
  return (
    <ItemList style={{ paddingTop: 0 }} pageColumn="wide">
      {draft && labels ? (
        <PublicProfileWidgetPreviewContext.Provider value={widgetPreview}>
        <PublicProfileEditor
          status={record?.state ?? 'draft'}
          renderEditBlocks={() => <PublicProfileWidgetArea widgetArea={widgetArea} clauses={areaUsage.clauses} />}
          mode={mode}
          onModeChange={setMode}
          changes={changeCount}
          ownerView={views?.owner ?? null}
          visitorView={views?.visitor ?? null}
          shellView={shellView}
          unavailable={!previewSnapshot && previewReason
            ? { reason: awaitingReason, onRetry: () => setAttempt(value => value + 1) } : null}
          hiddenBlockIds={views?.hidden ?? new Set()}
          pageLabels={labels}
          usage={usage}
          renderBand={renderBand}
          singleColumn={singleColumn}
          notice={widgetArea.status === 'unavailable' ? t('publicIdentity.profile.reasons.preparation_unavailable') : notice}
          submitting={submitting || consent.state.kind === 'pending'}
          canSubmit={widgetArea.candidate !== null}
          consentStatus={panel === 'publicData' ? null : consentStatus}
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
                  disabled={consent.state.kind === 'pending'}
                  status={panel === 'publicData' ? consentStatus : null}
                  onToggle={(field, shown) => { void consent.updateField(field, shown); }}
                />
              </LookPopover>
            </>
          )}
        />
        </PublicProfileWidgetPreviewContext.Provider>
      ) : (
        <>
          <SettingsPageHeader title={t('publicIdentity.editor.title')} />
          <SurfaceStateCard
            testID="public-profile-editor-loading"
            kind="loading"
            title={t('publicIdentity.editor.preparing')}
            replacesContent
          />
        </>
      )}
    </ItemList>
  );
}

function profileBand(draft: PublicProfileDraft, applied: PublicProfileAppearanceV1 | null, appliedPictureData: string | null)
  : ((geometry: HappierPublicProfileHeroGeometry) => React.ReactNode) | undefined {
  if (draft.appearance.kind === 'applied' && applied?.atmosphere.source === 'picture') {
    // The applied picture is the reviewed public copy, painted with its frozen look as visitors' pages are.
    const picture = applied.atmosphere.picture;
    return geometry => <View style={[styles.band, { height: geometry.bandHeightPx }]}>
      <PublicPictureBand picture={picture} data={appliedPictureData} copyId={picture.ref.id} /></View>;
  }
  const presentation = draftLookPresentation(draft, applied);
  if (presentation.source === 'none') return undefined;
  const target = { publicProfile: presentation };
  return geometry => <View style={[styles.band, { height: geometry.bandHeightPx }]}><AtmospherePreview target={target} frame="band" /></View>;
}

/** The review's picture at the public band's proportion, so the owner judges the crop visitors get. */
function ReviewPictureBand(props: React.ComponentProps<typeof PublicPictureBand>) {
  return <View style={styles.reviewBand}><PublicPictureBand {...props} /></View>;
}


function PublicProfileReviewModal(
  props: CustomModalInjectedProps &
    Readonly<{
      kind: 'publish' | 'apply';
      service: string;
      pageUrl: string | null;
      period: string;
      sharedFields: readonly (typeof PUBLIC_PROFILE_FIELDS_V1)[number][];
      disclosure: unknown;
      preparationReason: PublicProfilePreparationUnavailableReasonV1 | null;
      renderPicture?: () => React.ReactNode;
      endToEndEncrypted: boolean;
      indexable: boolean;
      confirm: () => Promise<void>;
      cancel: () => void;
    }>,
) {
  const [confirming, setConfirming] = React.useState(false);
  return (
    <PublicProfileReview
      kind={props.kind}
      service={props.service}
      pageUrl={props.pageUrl}
      period={props.period}
      sharedFields={props.sharedFields}
      disclosure={props.disclosure}
      preparationReason={props.preparationReason}
      renderPicture={props.renderPicture}
      endToEndEncrypted={props.endToEndEncrypted}
      indexable={props.indexable}
      confirming={confirming}
      setChrome={props.setChrome}
      onCancel={() => { props.cancel(); props.onClose(); }}
      onConfirm={() => {
        setConfirming(true);
        void props.confirm().finally(props.onClose);
      }}
    />
  );
}

const styles = StyleSheet.create(() => ({
  band: { width: '100%' },
  reviewBand: {
    width: '100%',
    aspectRatio:
      HAPPIER_PUBLIC_PROFILE_HERO_METRICS.rasterWidthPx.wide /
      HAPPIER_PUBLIC_PROFILE_HERO_METRICS.bandHeightPx.wide,
  },
}));
