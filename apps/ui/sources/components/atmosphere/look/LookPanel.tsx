import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { t } from '@/text';
import { GlassAppearanceControls } from '@/components/settings/appearance/GlassAppearanceControls';
import { useAtmospherePictureCatalog } from '../useAtmospherePictureCatalog';
import type { AtmospherePicture } from '@happier-dev/brand/atmosphere';
import type { AtmosphereEditor } from './atmosphereEditor';
import { PictureControls, PlanetControls, SourceControl } from './LookControls';
import { Item } from '@/components/ui/lists/Item';
import { Switch } from '@/components/ui/forms/Switch';

/**
 * Look: the one control for the atmosphere behind Home, a new session or a project (lab Personalize).
 * The same content sits in the desktop popover and the phone sheet. Source first; then the planet's
 * placement, style and digits, or the picture, its look, fade, strength and layout; then the glass
 * over it (the existing glass controls, writing the existing glass settings). Every block has the one
 * panel anatomy: a small header with its control beneath.
 */
export const LookPanel = React.memo(function LookPanel(
  props: Readonly<{
    editor: AtmosphereEditor;
    testID?: string;
  }>,
) {
  const { editor } = props;
  const pictures = useAtmospherePictureCatalog();
  const same = editor.sameAsHome === true;
  // Turning it off keeps Home's current atmosphere as this project's own, to change from there.
  const setSame = (value: boolean) => {
    if (value) editor.resetToHome?.();
    else editor.update((current) => current);
  };
  return (
    <View style={styles.panel} testID={props.testID}>
      {editor.resetToHome ? (
        <Item
          testID="look-same-as-home"
          title={t('settingsAppearance.glassControls.sameAsHome')}
          subtitle={t(same ? 'settingsAppearance.glassControls.sameAsHomeOn' : 'settingsAppearance.glassControls.sameAsHomeOff')}
          showChevron={false}
          onPress={() => setSame(!same)}
          rightElement={<Switch value={same} onValueChange={setSame} />}
        />
      ) : null}
      <LookBackdropControls editor={editor} pictures={pictures} />
      <GlassAppearanceControls presentation="panel" />
    </View>
  );
});

/**
 * The backdrop half of Look: the source, then the planet's or the picture's controls. Home's panel adds
 * the global glass beneath; a public profile's Look shows only these, so its edits never reach glass.
 */
export function LookBackdropControls(
  props: Readonly<{
    editor: AtmosphereEditor;
    pictures: readonly AtmospherePicture[];
  }>,
) {
  const { editor, pictures } = props;
  return (
    <>
      <SourceControl editor={editor} presentation="panel" pictures={pictures} />
      {editor.value.source === 'planet' ? (
        <PlanetControls editor={editor} presentation="panel" />
      ) : editor.value.source === 'picture' ? (
        <PictureControls
          editor={editor}
          presentation="panel"
          pictures={pictures}
        />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create(() => ({
  panel: { paddingBottom: 4 },
}));
