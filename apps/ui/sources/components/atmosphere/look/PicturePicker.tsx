import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { AtmospherePicture } from '@happier-dev/brand/atmosphere';
import {
  SelectionTiles,
  type SelectionTile,
} from '@/components/ui/forms/SelectionTiles';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { HAPPIER_PRESS_FEEDBACK_V1, HappierPressable, happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { resolveTouchTargetFloorPx } from '@/components/ui/interactiveTargetSize';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { t } from '@/text';
import { openExternalUrl } from '@/utils/url/openExternalUrl';
import type { AtmospherePictureActions } from './atmosphereEditor';
import type { PictureInfo } from '../pictureStore.types';
import type { PictureRef } from './atmosphereEdits';
import { PictureImagePreview } from './lookPreviews';
import { pictureCreditLine, pictureTitle } from './pictureCredit';
import {
  useBuiltinThumbnail,
  useStoredPictureBytes,
  useUserPictures,
} from './usePictureBytes';

const ADD_TILE_ID = 'add-your-picture';
const USER_PREFIX = 'user:';

function BuiltinThumbnail(props: Readonly<{ picture: AtmospherePicture }>) {
  return <PictureImagePreview bytes={useBuiltinThumbnail(props.picture)} />;
}
function UserThumbnail(props: Readonly<{ localId: string }>) {
  return <PictureImagePreview bytes={useStoredPictureBytes(props.localId)} />;
}
function AddThumbnail() {
  const { theme } = useUnistyles();
  return (
    <View style={styles.add}>
      <Icon
        name="image"
        size={ICON_SIZE.sm}
        color={theme.colors.text.secondary}
      />
    </View>
  );
}

/**
 * The built-in pictures (and plugin pictures) as thumbnails, this device's own pictures after them,
 * then "Your picture…". Choosing one selects it; the line below credits the chosen picture or, for
 * your own, says it stays on this device and offers to remove it.
 */
export const PicturePicker = React.memo(function PicturePicker(
  props: Readonly<{
    pictures: readonly AtmospherePicture[];
    selected: PictureRef | null;
    onSelect: (ref: PictureRef) => void;
    pictureActions?: AtmospherePictureActions;
    /** Thumbnails per row: four in the Look panel, more across a Settings page. */
    columns?: number;
    testID?: string;
  }>,
) {
  const { onSelect } = props;
  const scope = useAccountSettingsScope();
  const execution = useMountedActionExecution(props.pictureActions?.target.serverId ?? scope, {
    executorOptions: props.pictureActions?.executorOptions,
    retainInvocation: true,
  });
  const userPictures = useUserPictures();
  const options = React.useMemo(
    (): Array<SelectionTile<string>> => [
      ...props.pictures.map((picture) => ({
        id: picture.id,
        title: pictureTitle(picture),
        preview: <BuiltinThumbnail picture={picture} />,
      })),
      ...userPictures.map((info: PictureInfo) => ({
        id: `${USER_PREFIX}${info.localId}`,
        title: t('settingsAppearance.glassControls.yourPicture'),
        preview: <UserThumbnail localId={info.localId} />,
      })),
      {
        id: ADD_TILE_ID,
        title: t('settingsAppearance.glassControls.yourPictureAdd'),
        preview: <AddThumbnail />,
        previewEdge: 'dashed',
      },
    ],
    [props.pictures, userPictures],
  );
  const value =
    props.selected === null
      ? null
      : props.selected.kind === 'builtin'
        ? props.selected.id
        : `${USER_PREFIX}${props.selected.localId}`;
  const add = React.useCallback(async () => {
    try {
      const result = await execution.execute('settings.invoke', {
        anchor: 'appearance.atmospherePictureAdd',
        ...(props.pictureActions ? { target: props.pictureActions.target } : {}),
        input: { kind: 'atmosphere_picture_add', source: { kind: 'picked' } },
      });
      if (!result.ok && result.errorCode !== 'approval_rejected' && result.errorCode !== 'approval_canceled' && execution.isCurrent()) {
        await Modal.alertAsync(t('common.error'), t('common.unavailable'));
      }
    } catch (error) {
      if (!execution.isCurrent()) return;
      await Modal.alertAsync(
        t('common.error'),
        error instanceof Error ? error.message : String(error),
      );
    }
  }, [execution.execute, execution.isCurrent, props.pictureActions]);
  const remove = React.useCallback(async (localId: string) => {
    const result = await execution.execute('settings.invoke', {
      anchor: 'appearance.atmospherePictureRemove',
      ...(props.pictureActions ? { target: props.pictureActions.target } : {}),
      input: { kind: 'atmosphere_picture_remove', localId },
    });
    if (!result.ok && result.errorCode !== 'approval_rejected' && result.errorCode !== 'approval_canceled' && execution.isCurrent()) {
      await Modal.alertAsync(t('common.error'), t('common.unavailable'));
    }
  }, [execution.execute, execution.isCurrent, props.pictureActions]);
  const onChange = React.useCallback(
    (id: string | null) => {
      if (id === null) return;
      if (id === ADD_TILE_ID) {
        void add();
        return;
      }
      onSelect(
        id.startsWith(USER_PREFIX)
          ? { kind: 'user', localId: id.slice(USER_PREFIX.length) }
          : { kind: 'builtin', id },
      );
    },
    [add, onSelect],
  );
  const selected = props.selected;
  const chosenUser =
    selected?.kind === 'user' && userPictures.some((info) => info.localId === selected.localId) ? selected.localId : null;
  const chosenBuiltin =
    selected?.kind === 'builtin' ? (props.pictures.find((picture) => picture.id === selected.id) ?? null) : null;
  return (
    <View style={styles.picker} testID={props.testID}>
      <SelectionTiles
        variant="visual"
        tileSizing="fill"
        labels="hidden"
        maximumColumns={props.columns ?? 4}
        previewAspectRatio={16 / 10}
        accessibilityLabel={t(
          'settingsAppearance.glassControls.atmospherePictureRef',
        )}
        testIdPrefix="atmosphere-picture"
        options={options}
        value={value}
        onChange={onChange}
      />
      {chosenBuiltin ? (
        <PictureCredit picture={chosenBuiltin} />
      ) : chosenUser ? (
        <UserPictureLine localId={chosenUser} onRemove={remove} />
      ) : null}
    </View>
  );
});

/** "Title · Photo · Author · Unsplash": the credit links to the picture's page at its source. */
function PictureCredit(props: Readonly<{ picture: AtmospherePicture }>) {
  const { picture } = props;
  const { theme } = useUnistyles();
  const targetFloor = resolveTouchTargetFloorPx() ?? undefined;
  return (
    <HappierPressable
      accessibilityRole="link"
      accessibilityLabel={`${pictureTitle(picture)} · ${pictureCreditLine(picture)}`}
      testID="atmosphere-picture-credit"
      onPress={() => {
        void openExternalUrl(picture.credit.url);
      }}
      style={({ focused, pressed }) => [
        styles.line,
        { minHeight: targetFloor, minWidth: targetFloor, opacity: pressed ? HAPPIER_PRESS_FEEDBACK_V1.opacity : 1 },
        focusRingStyle({ focused, color: theme.colors.border.focus }),
      ]}
    >
      {({ hovered }) => <Text style={[styles.lineMeta, hovered && { textDecorationLine: 'underline' }]} numberOfLines={2}>
          <Text style={styles.lineTitle}>{pictureTitle(picture)}</Text>
          {` · ${pictureCreditLine(picture)}`}
        </Text>}
    </HappierPressable>
  );
}

function UserPictureLine(props: Readonly<{ localId: string; onRemove(localId: string): Promise<void> }>) {
  return (
    <View style={styles.line}>
      <Text style={styles.lineTitle} numberOfLines={1}>
        {t('settingsAppearance.glassControls.yourPicture')}
      </Text>
      <Text
        style={[styles.lineMeta, styles.grow]}
        numberOfLines={1}
      >{` · ${t('settingsAppearance.glassControls.yourPictureNote')}`}</Text>
      <TextLinkButton
        label={t('common.remove')}
        accessibilityLabel={t('settingsAppearance.glassControls.atmospherePictureRemove')}
        testID="atmosphere-picture-remove"
        onPress={() => props.onRemove(props.localId)}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  picker: { gap: theme.space.s8 },
  add: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  line: { flexDirection: 'row', alignItems: 'center' },
  grow: { flexShrink: 1, flexGrow: 1 },
  lineTitle: {
    ...Typography.default('medium'),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.primary,
    
  },
  lineMeta: {
    ...Typography.default(),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.secondary,
    flexShrink: 1,
  },
}));
