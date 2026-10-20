import type { ReactElement, ReactNode } from 'react';

import {
  HappierTechnicalDetailsDisclosure,
  type HappierTechnicalDetailsContentProps,
  type HappierTechnicalDetailsLine,
} from '../presentation/collection/TechnicalDetailsDisclosure.js';
import { CountedDisclosureItem } from './CountedDisclosureItem.js';

export type TechnicalDetailsLine = HappierTechnicalDetailsLine;
export type TechnicalDetailsDisclosureProps = HappierTechnicalDetailsContentProps;

function TechnicalDetailsFold(props: Readonly<{ title: string; testID?: string; children: ReactNode }>): ReactElement {
  return <CountedDisclosureItem title={props.title} testID={props.testID}>{props.children}</CountedDisclosureItem>;
}

/**
 * The "Technical details" row Happier's own approvals and Run steps draw: exact identifiers and codes
 * folded one tap away, each a quiet label over its selectable mono value. Lead your page with the
 * readable outcome and put the code and raw cause here. With no lines it draws nothing.
 */
export function TechnicalDetailsDisclosure(props: TechnicalDetailsDisclosureProps): ReactElement | null {
  return <HappierTechnicalDetailsDisclosure {...props} Disclosure={TechnicalDetailsFold} />;
}
