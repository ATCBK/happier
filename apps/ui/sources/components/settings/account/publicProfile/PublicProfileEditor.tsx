import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import {
  HappierPublicProfile,
  type HappierPublicProfileHeroGeometry,
  type HappierPublicProfileLabels,
  type HappierPublicProfileUsageHost,
} from '@happier-dev/plugin-ui/presentation';
import type { PublicProfileViewV1 } from '@happier-dev/protocol/account/publicProfilePublication';

import { CorePluginUiPresentationScope } from '@/components/plugins/surfaces/CorePluginUiPresentationScope';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

export type PublicProfileEditorView = Omit<PublicProfileViewV1, 'appearance'>;
export type PublicProfileEditorProps = Readonly<{
  status: 'draft' | 'published' | 'paused';
  mode: 'edit' | 'preview';
  onModeChange: (mode: 'edit' | 'preview') => void;
  /** How many members (consent, blocks, look) differ from the public edition. */
  changes: number;
  /** Every placed block with the owner's own local values; never uploaded. */
  ownerView: PublicProfileEditorView | null;
  /** Exactly what visitors would read, from the one disclosure projector. */
  visitorView: PublicProfileEditorView | null;
  hiddenBlockIds: ReadonlySet<string>;
  pageLabels: HappierPublicProfileLabels;
  usage?: HappierPublicProfileUsageHost;
  renderBand?: (geometry: HappierPublicProfileHeroGeometry) => React.ReactNode;
  singleColumn?: boolean;
  notice: string | null;
  submitting: boolean;
  onSubmit: () => void;
  /** Look and Public data, each anchored to its own control. */
  renderTools: () => React.ReactNode;
}>;

/**
 * The owner's own page (lab `ppcomp-E`, `ppflow-F2`): the same placed tree visitors read, with every
 * block present in Edit (private ones quieted and labelled) and only the shared ones in Preview.
 * Nothing here is public until Publish or Apply.
 */
export function PublicProfileEditor(
  props: PublicProfileEditorProps,
): React.ReactElement {
  const view = props.mode === 'edit' ? props.ownerView : props.visitorView;
  const published = props.status !== 'draft';
  const statusLabel =
    props.status === 'draft'
      ? t('publicIdentity.editor.statusDraft')
      : props.status === 'paused'
        ? t('publicIdentity.editor.statusPaused')
        : t('publicIdentity.editor.statusPublished');
  const hint = !published
    ? t('publicIdentity.editor.hintNew')
    : props.changes > 0
      ? t('publicIdentity.editor.hintChanges', { count: props.changes })
      : t('publicIdentity.editor.hintNone');
  return (
    <View style={styles.page} testID="public-profile-editor">
      <View style={styles.toolbar}>
        <Text
          variant="meta"
          style={styles.status}
          testID="public-profile-editor-status"
        >
          {statusLabel}
        </Text>
        <View style={styles.toolbarEnd}>
          <SegmentedTabBar<'edit' | 'preview'>
            tabs={[
              { id: 'edit', label: t('publicIdentity.editor.edit') },
              { id: 'preview', label: t('publicIdentity.editor.preview') },
            ]}
            activeTabId={props.mode}
            onSelectTab={props.onModeChange}
            testIDPrefix="public-profile-editor-mode"
            segmentSizing="content"
          />
          <RoundButton
            testID="public-profile-editor-submit"
            size="small"
            title={
              published
                ? t('publicIdentity.editor.apply')
                : t('publicIdentity.editor.publish')
            }
            disabled={props.submitting || (published && props.changes === 0)}
            loading={props.submitting}
            onPress={props.onSubmit}
          />
        </View>
      </View>
      {props.mode === 'edit' ? (
        <View style={styles.banner} testID="public-profile-editor-banner">
          <View style={styles.bannerText}>
            <Text variant="label" emphasis="semiBold">
              {t('publicIdentity.editor.customizing')}
            </Text>
            <Text variant="meta" style={styles.secondary}>
              {hint}
            </Text>
          </View>
          <View style={styles.tools}>{props.renderTools()}</View>
        </View>
      ) : null}
      {props.notice ? (
        <SurfaceStateCard
          testID="public-profile-editor-notice"
          kind="warning"
          layout="inline"
          size="line"
          title={props.notice}
        />
      ) : null}
      {view ? (
        <CorePluginUiPresentationScope>
          <HappierPublicProfile
            view={view}
            labels={props.pageLabels}
            usage={props.usage}
            singleColumn={props.singleColumn}
            renderHero={props.renderBand}
            {...(props.mode === 'edit'
              ? {
                  owner: {
                    hiddenBlockIds: props.hiddenBlockIds,
                    onlyYou: t('publicIdentity.editor.onlyYou'),
                  },
                }
              : {})}
          />
        </CorePluginUiPresentationScope>
      ) : (
        <SurfaceStateCard
          testID="public-profile-editor-preparing"
          kind="loading"
          title={t('publicIdentity.editor.preparing')}
          replacesContent
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  page: { width: '100%', gap: theme.space.s16 },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: theme.space.s12,
  },
  toolbarEnd: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s12,
  },
  status: { color: theme.colors.text.secondary },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: theme.space.s12,
    paddingHorizontal: theme.space.s16,
    paddingVertical: theme.space.s10,
    borderRadius: theme.borderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border.default,
  },
  bannerText: { flex: 1, minWidth: 0, gap: theme.space.s2 },
  secondary: { color: theme.colors.text.secondary },
  tools: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
}));
