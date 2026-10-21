import * as React from 'react';

export function LazyMountOnScreen(props: Readonly<{
    children: React.ReactNode;
    initiallyVisible?: boolean;
    style?: React.CSSProperties;
}>) {
    return <>{props.children}</>;
}
