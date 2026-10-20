import type { View } from 'react-native';

/**
 * The stage owns its origin's visibility (lab files MS1d): while the picture is out, the thumbnail's
 * slot reads empty. On web a View ref is its DOM element; opacity keeps layout, focus and measurement.
 */
export function hideStageOrigin(node: View): () => void {
    const element = node as unknown as HTMLElement;
    if (!element.style) return () => {};
    const previous = element.style.opacity;
    element.style.opacity = '0';
    return () => {
        element.style.opacity = previous;
    };
}
