import { describe, expect, it, vi } from 'vitest';

import { HappierComposerChip } from '@happier-dev/plugin-ui/presentation';
import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';

describe('public Composer chip', () => {
  it('exports the host rail button semantics to plugin authors', () => {
    const onPress = vi.fn();
    const mounted = mountThroughReactNativeWeb(
      <HappierComposerChip
        accessibilityLabel="Run plugin action"
        expressesSelection
        selected
        onPress={onPress}
        style={() => ({ padding: 4 })}
      >
        Run
      </HappierComposerChip>,
    );
    try {
      const button = mounted.container.querySelector('button');
      expect(button?.getAttribute('aria-label')).toBe('Run plugin action');
      expect(button?.getAttribute('aria-pressed')).toBe('true');
      button?.click();
      expect(onPress).toHaveBeenCalledOnce();
    } finally {
      mounted.unmount();
    }
  });
});
