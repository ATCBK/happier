import * as React from 'react';
import { type StyleProp, type ViewStyle } from 'react-native';

import { PageFrame } from './PageFrame';

type ConstrainedScreenContentProps = Readonly<{
    children: React.ReactNode;
    style?: StyleProp<ViewStyle>;
}>;

export const ConstrainedScreenContent = React.memo((props: ConstrainedScreenContentProps) => {
    return (
        <PageFrame content="column" style={props.style}>
            {props.children}
        </PageFrame>
    );
});
