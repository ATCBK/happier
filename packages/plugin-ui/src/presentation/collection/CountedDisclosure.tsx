import { useState, type ComponentType, type ReactElement, type ReactNode } from 'react';

import type { HappierDisclosureHeaderState, HappierDisclosureProps } from './Disclosure.js';

/** A quiet aggregate row: its count or word summary stays visible while details are folded. */
export type HappierCountedDisclosureContentProps = Readonly<{
  title: string;
  count?: number;
  subtitle?: string;
  /** A glyph in the row's leading column, when its siblings carry one. */
  icon?: ReactNode;
  /** The inter-item hairline; omitted, the fold draws none. */
  showDivider?: boolean;
  testID?: string;
  children: ReactNode;
}>;

/** The existing disclosure adapter supplies host motion, theme and reveal intent. */
export type HappierCountedDisclosureFrameProps = Pick<HappierDisclosureProps,
  'expanded' | 'onExpandedChange' | 'header' | 'showDivider' | 'testID' | 'children'
>;

export type HappierCountedDisclosureHeaderState = HappierDisclosureHeaderState & Readonly<{
  title: string;
  subtitle?: string;
  subtitleNumberOfLines?: 1;
  icon?: ReactNode;
  detail?: string;
  testID?: string;
}>;

export type HappierCountedDisclosureProps = HappierCountedDisclosureContentProps & Readonly<{
  Disclosure: ComponentType<HappierCountedDisclosureFrameProps>;
  renderHeader: (state: HappierCountedDisclosureHeaderState) => ReactNode;
}>;

/** One fold state and summary composition; the existing disclosure owns lazy mounting and motion. */
export function HappierCountedDisclosure(props: HappierCountedDisclosureProps): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const Disclosure = props.Disclosure;
  return (
    <Disclosure
      testID={props.testID}
      expanded={expanded}
      onExpandedChange={setExpanded}
      showDivider={props.showDivider ?? false}
      header={(state) => props.renderHeader({
        ...state,
        title: props.title,
        subtitle: props.subtitle,
        subtitleNumberOfLines: props.subtitle ? 1 : undefined,
        icon: props.icon,
        detail: props.count === undefined ? undefined : String(props.count),
        testID: props.testID ? `${props.testID}.header` : undefined,
      })}
    >
      {props.children}
    </Disclosure>
  );
}
