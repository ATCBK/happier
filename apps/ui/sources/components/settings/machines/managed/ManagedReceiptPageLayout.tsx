import * as React from 'react';

import { PageAsideColumns } from '@/components/ui/layout/PageAsideColumns';
import {
  PageHeader,
  type PageHeaderProps,
} from '@/components/ui/layout/PageHeader';
import { ItemList } from '@/components/ui/lists/ItemList';

import {
  MachineConfigurationReceipt,
  type ManagedReceiptModel,
} from './MachineConfigurationReceipt';

/**
 * A machine's choices beside their receipt (configurator, preset, created machine), in the shared
 * page-aside columns: the receipt stays in view while the sections scroll, so the consequence never
 * leaves the screen; a phone (or a pane too narrow for both) reads the sections first and the receipt
 * after. `compactReceipt="first"` leads a phone with the receipt when the receipt is the thing's
 * identity (a preset is its recipe).
 */
export const ManagedReceiptColumns = React.memo(function ManagedReceiptColumns(
  props: Readonly<{
    children: React.ReactNode;
    receipt: ManagedReceiptModel | null;
    compact: boolean;
    closing?: React.ReactNode;
    compactReceipt?: 'first' | 'last';
    testID: string;
  }>,
) {
  return (
    <PageAsideColumns
      aside={props.receipt ? (
        <MachineConfigurationReceipt
          model={props.receipt}
          testID={`${props.testID}.receipt`}
        />
      ) : null}
      compact={props.compact}
      closing={props.closing}
      compactAside={props.compactReceipt}
    >
      {props.children}
    </PageAsideColumns>
  );
});

/**
 * A page about a machine's choices: the header, then the sections beside their receipt.
 */
export const ManagedReceiptPageLayout = React.memo(
  function ManagedReceiptPageLayout(
    props: Readonly<{
      header: PageHeaderProps;
      children: React.ReactNode;
      receipt: ManagedReceiptModel | null;
      compact: boolean;
      closing?: React.ReactNode;
      compactReceipt?: 'first' | 'last';
      testID: string;
    }>,
  ) {
    return (
      <ItemList testID={props.testID} pageColumn="wide">
        <PageHeader {...props.header} />
        <ManagedReceiptColumns
          receipt={props.receipt}
          compact={props.compact}
          closing={props.closing}
          compactReceipt={props.compactReceipt}
          testID={props.testID}
        >
          {props.children}
        </ManagedReceiptColumns>
      </ItemList>
    );
  },
);
