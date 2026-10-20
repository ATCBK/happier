import type { View } from 'react-native';

/**
 * The stage owns its origin's visibility (lab files MS1d): while the picture is out, the thumbnail's
 * slot reads empty, so the flight and the drag-dismiss never show two copies. Returns the restore.
 */
export function hideStageOrigin(node: View): () => void {
    node.setNativeProps({ style: { opacity: 0 } });
    return () => node.setNativeProps({ style: { opacity: 1 } });
}
