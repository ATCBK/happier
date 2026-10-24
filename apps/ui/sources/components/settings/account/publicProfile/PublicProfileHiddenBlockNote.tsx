import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import {
  PUBLIC_PROFILE_FIELDS_V1,
  type PublicProfileField,
  type PublicProfilePolicyV1,
  type PublicProfileSnapshotV1,
} from '@happier-dev/protocol/account/publicProfile';
import { projectPublicProfilePreview } from '@happier-dev/protocol/account/projectPublicProfile';
import type {
  PublicProfileContextV1,
  PublicProfileLayoutV1,
} from '@happier-dev/protocol/account/publicProfilePublication';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

const NO_APPEARANCE = {
  atmosphere: { source: 'none' },
  theme: 'auto',
} as const;

/**
 * The one item a hidden block waits for: the first unshared item that, shared alone, lets the one
 * disclosure projector draw it. Asked only for a block visitors don't see, never for the whole page.
 */
export function resolvePublicProfileBlockShareField(
  input: Readonly<{
    blockId: string;
    layout: PublicProfileLayoutV1;
    context: PublicProfileContextV1;
    snapshot: PublicProfileSnapshotV1;
    policy: PublicProfilePolicyV1;
  }>,
): PublicProfileField | null {
  const block = input.layout.items
    .flatMap((item) => (item.kind === 'widget' ? [item] : item.children))
    .find((item) => item.id === input.blockId);
  if (!block) return null;
  const layout: PublicProfileLayoutV1 = { v: 1, items: [block] };
  return (
    PUBLIC_PROFILE_FIELDS_V1.find(
      (field) =>
        !input.policy.fields[field] &&
        (projectPublicProfilePreview({
          context: input.context,
          metadata: {},
          snapshot: input.snapshot,
          layout,
          appearance: NO_APPEARANCE,
          policy: {
            ...input.policy,
            fields: { ...input.policy.fields, [field]: true },
          },
        })?.layout.items.length ?? 0) > 0,
    ) ?? null
  );
}

/**
 * Under a block visitors don't see (lab `ppcomp-E`): which item it needs, and Share for exactly that
 * item through the page's one consent owner. Placing a block never shares anything by itself.
 */
export function PublicProfileHiddenBlockNote(
  props: Readonly<{
    blockId: string;
    layout: PublicProfileLayoutV1;
    context: PublicProfileContextV1;
    snapshot: PublicProfileSnapshotV1;
    policy: PublicProfilePolicyV1;
    disabled: boolean;
    onShare: (field: PublicProfileField) => void;
  }>,
): React.ReactElement | null {
  const { blockId, layout, context, snapshot, policy } = props;
  const field = React.useMemo(
    () =>
      resolvePublicProfileBlockShareField({
        blockId,
        layout,
        context,
        snapshot,
        policy,
      }),
    [blockId, layout, context, snapshot, policy],
  );
  const item = field ? t(`publicIdentity.publicData.fields.${field}`) : null;
  return (
    <View style={styles.note} testID={`public-profile-hidden-note-${blockId}`}>
      <Text variant="meta" style={styles.text}>
        {item
          ? t('publicIdentity.editor.hiddenBlock', { item })
          : t('publicIdentity.editor.hiddenBlockNoItem')}
      </Text>
      {field && item ? (
        <RoundButton
          testID={`public-profile-hidden-share-${blockId}`}
          size="small"
          display="secondary"
          title={t('publicIdentity.editor.shareItem', { item })}
          disabled={props.disabled}
          onPress={() => props.onShare(field)}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  note: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.space.s8,
  },
  text: {
    flexShrink: 1,
    flexBasis: 220,
    flexGrow: 1,
    color: theme.colors.text.secondary,
  },
}));
