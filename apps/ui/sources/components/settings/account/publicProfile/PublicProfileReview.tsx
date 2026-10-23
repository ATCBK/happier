import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import {
  PUBLIC_PROFILE_FIELDS_V1,
  type PublicProfileField,
} from '@happier-dev/protocol/account/publicProfile';
import type { PublicProfilePreparationUnavailableReasonV1 } from '@happier-dev/protocol/account/publicProfileIntents';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { CodeBlockView } from '@/components/ui/code/blocks/CodeBlockView';
import {
  ExpandableItem,
  ExpandableItemCaret,
} from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

export type PublicProfileReviewProps = Readonly<{
  kind: 'publish' | 'apply';
  service: string;
  /** Where the page lives, from the service's canonical public URL. */
  pageUrl: string | null;
  /** The captured window the published numbers cover. */
  period: string;
  sharedFields: readonly PublicProfileField[];
  /** Exactly what visitors would read, as captured for this review. */
  disclosure: unknown;
  preparationReason?: PublicProfilePreparationUnavailableReasonV1 | null;
  /** The retained picture copy Confirm sends; absent when no picture leaves the device. */
  renderPicture?: () => React.ReactNode;
  endToEndEncrypted: boolean;
  indexable: boolean;
  confirming: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}>;

/**
 * The one review before anything leaves the device (lab `ppflow-F2d`): where it lives and what period
 * it covers, which items become public and which stay hidden, what stays readable by the service, the
 * exact picture copy that is uploaded, and the exact data visitors can read.
 */
export function PublicProfileReview(
  props: PublicProfileReviewProps,
): React.ReactElement {
  const [showData, setShowData] = React.useState(false);
  const shared = new Set(props.sharedFields);
  const hidden = PUBLIC_PROFILE_FIELDS_V1.filter((field) => !shared.has(field));
  const names = (fields: readonly PublicProfileField[]) =>
    fields
      .map((field) => t(`publicIdentity.publicData.fields.${field}`))
      .join(' · ');
  // Q13: weekly shares are percentages, but with the Tokens total public they reveal weekly amounts.
  const jointInference = shared.has('tokens') && shared.has('weeklyAgentMix');
  const preparationNotice = props.preparationReason ? t(`publicIdentity.profile.reasons.${props.preparationReason}`) : null;
  const consequences = [
    jointInference
      ? t('publicIdentity.publicData.details.weeklyAgentMix')
      : null,
    // What is never part of it, in the page's own words (lab F2d "Never part of it").
    t('publicIdentity.page.footerNote'),
    props.endToEndEncrypted ? t('publicIdentity.review.plaintext') : null,
    props.kind === 'publish' ? t('publicIdentity.review.daily') : null,
    props.indexable ? null : t('publicIdentity.review.noindex'),
  ].filter((line): line is string => line !== null);
  const json = React.useMemo(
    () => (showData ? preparationNotice ?? JSON.stringify(props.disclosure, null, 2) : ''),
    [showData, preparationNotice, props.disclosure],
  );
  return (
    <View style={styles.body} testID="public-profile-review">
      {props.pageUrl ? (
        <Text variant="body" style={styles.secondary}>
          {t('publicIdentity.review.where', {
            url: props.pageUrl,
            period: props.period,
          })}
        </Text>
      ) : null}
      <View style={styles.section}>
        <Text variant="label" emphasis="semiBold">
          {t('publicIdentity.review.intro', { service: props.service })}
        </Text>
        <Text variant="body" testID="public-profile-review-items">
          {props.sharedFields.length > 0
            ? names(props.sharedFields)
            : t('publicIdentity.review.none')}
        </Text>
      </View>
      {hidden.length > 0 ? (
        <View style={styles.section}>
          <Text variant="label" emphasis="semiBold">
            {t('publicIdentity.review.hidden')}
          </Text>
          <Text
            variant="body"
            style={styles.secondary}
            testID="public-profile-review-hidden"
          >
            {names(hidden)}
          </Text>
        </View>
      ) : null}
      {props.renderPicture ? (
        <View style={styles.section} testID="public-profile-review-picture">
          <View style={styles.picture}>{props.renderPicture()}</View>
          <Text variant="meta" style={styles.secondary}>
            {t('publicIdentity.review.picture')}
          </Text>
        </View>
      ) : null}
      {consequences.map((line) => (
        <Text key={line} variant="meta" style={styles.secondary}>
          {line}
        </Text>
      ))}
      <ExpandableItem
        expanded={showData}
        onExpandedChange={setShowData}
        showDivider={false}
        header={(state) => (
          <Item
            {...state.headerProps}
            testID="public-profile-review-data"
            title={t('publicIdentity.review.viewData')}
            subtitle={preparationNotice ?? t('publicIdentity.review.viewDataDetail')}
            showChevron={false}
            rightElement={<ExpandableItemCaret expanded={state.expanded} />}
          />
        )}
      >
        {showData ? (
          <CodeBlockView
            code={json}
            language="json"
            selectable
            showCopyButton
          />
        ) : null}
      </ExpandableItem>
      <View style={styles.actions}>
        <RoundButton
          testID="public-profile-review-cancel"
          size="small"
          display="secondary"
          title={t('publicIdentity.review.cancel')}
          disabled={props.confirming}
          onPress={props.onCancel}
        />
        <RoundButton
          testID="public-profile-review-confirm"
          size="small"
          title={
            props.kind === 'publish'
              ? t('publicIdentity.review.confirmPublish')
              : t('publicIdentity.review.confirmApply')
          }
          loading={props.confirming}
          disabled={props.confirming}
          onPress={props.onConfirm}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  // The card chrome insets only its title band and footer; the review stands on that same edge.
  body: { gap: theme.space.s12, paddingHorizontal: theme.space.s16, paddingBottom: theme.space.s16 },
  section: { gap: theme.space.s4 },
  secondary: { color: theme.colors.text.secondary },
  picture: {
    overflow: 'hidden',
    borderRadius: theme.borderRadius.lg,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: theme.space.s8,
  },
}));
