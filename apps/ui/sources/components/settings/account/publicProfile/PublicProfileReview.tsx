import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { PublicProfileField } from '@happier-dev/protocol/account/publicProfile';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

export type PublicProfileReviewProps = Readonly<{
  kind: 'publish' | 'apply';
  service: string;
  sharedFields: readonly PublicProfileField[];
  endToEndEncrypted: boolean;
  uploadsPicture: boolean;
  indexable: boolean;
  confirming: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}>;

/**
 * The one review before anything leaves the device (lab `ppflow-F2d`): exactly which items become
 * public, what stays readable by the service, and the picture's pixels when one is uploaded.
 */
export function PublicProfileReview(
  props: PublicProfileReviewProps,
): React.ReactElement {
  const consequences = [
    props.endToEndEncrypted ? t('publicIdentity.review.plaintext') : null,
    props.uploadsPicture ? t('publicIdentity.review.picture') : null,
    props.kind === 'publish' ? t('publicIdentity.review.daily') : null,
    props.indexable ? null : t('publicIdentity.review.noindex'),
  ].filter((line): line is string => line !== null);
  return (
    <View style={styles.body} testID="public-profile-review">
      <View style={styles.section}>
        <Text variant="body">
          {t('publicIdentity.review.intro', { service: props.service })}
        </Text>
        <Text
          variant="body"
          emphasis="medium"
          testID="public-profile-review-items"
        >
          {props.sharedFields.length > 0
            ? props.sharedFields
                .map((field) => t(`publicIdentity.publicData.fields.${field}`))
                .join(', ')
            : t('publicIdentity.review.none')}
        </Text>
      </View>
      {consequences.map((line) => (
        <Text key={line} variant="meta" style={styles.secondary}>
          {line}
        </Text>
      ))}
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
  body: { gap: theme.space.s12 },
  section: { gap: theme.space.s4 },
  secondary: { color: theme.colors.text.secondary },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: theme.space.s8,
  },
}));
