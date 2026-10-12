import * as React from 'react';
import { type StyleProp, type ViewStyle } from 'react-native';

import { PageFrame } from '@/components/ui/layout/PageFrame';

/**
 * The page's content column for content that does not size itself: a page-sized `Collection`'s table or
 * grid, a widget area, a dashboard. Inside an `ItemList` it takes the page column's width (`reading` or
 * `wide`, under the person's content-width preference) and centres it, so that content shares one edge
 * with the `PageHeader` and every `ItemGroup` on the page. Owners that already size themselves to the
 * column (`PageHeader`, `ItemGroup`) are unaffected inside it.
 */
export function PageContentColumn(
  props: Readonly<{
    children?: React.ReactNode;
    style?: StyleProp<ViewStyle>;
    testID?: string;
  }>,
) {
  return (
    <PageFrame
      content="column"
      testID={props.testID}
      style={props.style}
    >
      {props.children}
    </PageFrame>
  );
}

