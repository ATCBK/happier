import { Platform, Text } from 'react-native';
import { describe, expect, it } from 'vitest';

import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { HappierOptionRow } from './OptionRow.js';

describe('HappierOptionRow platform semantics', () => {
    it('preserves a web-only ARIA role at the RNW host', () => {
        const view = mountThroughReactNativeWeb(<HappierOptionRow
            title="Choice"
            textComponent={({ children }) => <Text>{children}</Text>}
            styles={{}}
            rowStyle={() => ({})}
            splitPressOpacity={1}
            controlProps={{ testID: 'option', role: 'gridcell', accessibilityRole: 'radio' }}
        />);
        try {
            expect(view.container.querySelector('[data-testid="option"]')?.getAttribute('role')).toBe('gridcell');
        } finally {
            view.unmount();
        }
    });

    it.each([false, true])('uses native accessibility semantics without a web-only role (split=%s)', (split) => {
        const originalPlatform = Platform.OS;
        // Platform is the OS boundary; keep the row and RNW host implementation real.
        Platform.OS = 'ios';
        const view = mountThroughReactNativeWeb(<HappierOptionRow
            title="Choice"
            textComponent={({ children }) => <Text>{children}</Text>}
            styles={{}}
            rowStyle={() => ({})}
            splitPressOpacity={1}
            right={<Text>Accessory</Text>}
            rightElementOutsidePressable={split}
            controlProps={{ testID: 'option', role: 'gridcell', accessibilityRole: 'radio' }}
        />);
        try {
            expect(view.container.querySelector('[data-testid="option"]')?.getAttribute('role')).toBe('radio');
        } finally {
            view.unmount();
            Platform.OS = originalPlatform;
        }
    });
});
