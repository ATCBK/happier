import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { MediaViewerSpecimen } from '@/components/dev/media/MediaViewerSpecimen';

/** Dev-only: the Media stage and viewer bodies on bundled sample media, credential-free for visual QA. */
export default function MediaDevScreen() {
  return (
    <ScrollView style={styles.container} testID="dev-media-screen">
      <View style={styles.content}>
        <MediaViewerSpecimen />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background.canvas,
  },
  content: {
    padding: theme.space.s24,
  },
}));
