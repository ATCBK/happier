import { useState } from 'react';
import {
  CapabilityBlockingBanner,
  CapabilityDetailHeader,
  CapabilityFacts,
  CapabilityStatusChip,
  Collection,
  capabilityCollectionAnatomy,
  pickMostBlockingCapabilityStatus,
  useHappierCollection,
  type CapabilityStatus,
} from '@happier-dev/plugin-ui/components';

type Extension = Readonly<{
  id: string;
  name: string;
  purpose: string;
  scope: string;
  statuses: readonly CapabilityStatus[];
}>;

/**
 * A plugin that manages installable extensions renders them with Happier's capability kit: the list anatomy,
 * one extension's header, its blocking notice, and its facts. The author owns the data and the fixes.
 */
export function CapabilityKitExample(
  props: Readonly<{ onSignIn?: (id: string) => void }>,
) {
  const [signedIn, setSignedIn] = useState<readonly string[]>([]);
  const signIn = (id: string) => {
    props.onSignIn?.(id);
    setSignedIn((current) => [...current, id]);
  };
  const extensions: readonly Extension[] = [
    {
      id: 'linear',
      name: 'Linear',
      purpose: 'Read and update the issues your team works on.',
      scope: 'Everywhere',
      statuses: signedIn.includes('linear')
        ? []
        : [
            { kind: 'update' },
            {
              kind: 'signin',
              fix: { kind: 'sign_in', onPress: () => signIn('linear') },
            },
          ],
    },
    {
      id: 'figma',
      name: 'Figma',
      purpose: 'Read frames and comments from shared files.',
      scope: '2 projects',
      statuses: [],
    },
  ];
  const model = useHappierCollection({ items: extensions, keyOf: (item) => item.id, openKey: null, onOpenChange: () => undefined });
  const status = (item: Extension) =>
    pickMostBlockingCapabilityStatus(item.statuses);
  const linear = extensions[0]!;
  const linearStatus = pickMostBlockingCapabilityStatus(
    linear.statuses,
    'header',
  );
  return (
    <>
      <CapabilityDetailHeader
        testID="author-capability.header"
        title={linear.name}
        purpose={linear.purpose}
        facts={{
          source: { kind: 'registry', label: 'Extension registry' },
          trust: 'runs_scripts',
          cost: { toolCount: 12, tokensPerTurn: 2400 },
        }}
        status={linearStatus}
        mono="ext/linear"
      />
      {linearStatus ? (
        <CapabilityBlockingBanner
          testID="author-capability.banner"
          status={linearStatus}
          title="Linear is signed out"
          body="Sessions can’t use its tools until you sign in."
        />
      ) : null}
      <CapabilityStatusChip
        testID="author-capability.chip"
        status={{
          kind: 'error',
          machineName: 'build-box',
          detail: 'node is missing',
        }}
        placement="header"
      />
      <CapabilityFacts
        testID="author-capability.facts"
        source={{ kind: 'you' }}
        trust="text_only"
        cost={{ tokensWhenUsed: 1200 }}
      />
      <Collection
      model={model}
      accessibilityLabel="Extensions"
      presentation="list"
      detail="none"
      scroll="page"
      minListWidth={240}
      minDetailWidth={240}
      preferredListRatio={0.5}
      anatomy={capabilityCollectionAnatomy<Extension>({
        title: (item) => item.name,
        description: (item) => item.purpose,
        whereSummary: (item) => item.scope,
        facts: () => ({ source: { kind: 'registry', label: 'Extension registry' }, trust: 'has_files' }),
        status,
        accessibilityLabel: (item) => item.name,
        testID: (item) => `author-capability.row.${item.id}`,
      })}
    />
    </>
  );
}
