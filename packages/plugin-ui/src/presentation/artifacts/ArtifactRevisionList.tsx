import type { ComponentType, ReactNode } from 'react';
import { View } from 'react-native';

import { HAPPIER_PAGE_METRICS } from '../layout/pageMetrics.js';
import type { HappierPortableStyle } from '../portableTypes.js';

export type HappierArtifactRevisionRow = Readonly<{
  bodyVersion: number;
  title: string;
  /** Already localized time and saved provenance from the revision's canonical owner. */
  subtitle: string;
  detail: string;
}>;

export type HappierArtifactRevisionListProps = Readonly<{
  sideBySide: boolean;
  title: string;
  currentTitle: string;
  currentSubtitle?: string;
  currentLabel: string;
  retentionLabel: string;
  revisions: readonly HappierArtifactRevisionRow[];
  selectedVersion: number | null;
  onSelectVersion: (bodyVersion: number) => void;
  /** `divider` draws the side-by-side list column's trailing hairline (lab A6: list pane | preview pane). */
  colors: Readonly<{ secondary: string; tertiary: string; divider?: string }>;
  host: Readonly<{
    ItemGroup: ComponentType<Readonly<{ title: string; children?: ReactNode }>>;
    Item: ComponentType<Readonly<{ testID: string; title: string; subtitle?: string; detail?: string; selected?: boolean; onPress?: () => void; titleAccessory?: ReactNode; leading?: ReactNode; showChevron: boolean }>>;
    Text: ComponentType<Readonly<{ children: string; style: HappierPortableStyle }>>;
    /** The host's status pill for the current version's "Now"; without one the label is quiet text. */
    Badge?: ComponentType<Readonly<{ label: string }>>;
  }>;
}>;

/** List presentation only. Fetch, preview, revision authority and restore remain host-owned. */
export function HappierArtifactRevisionList(props: HappierArtifactRevisionListProps) {
  const { ItemGroup, Item, Text, Badge } = props.host;
  // Quiet timeline marks (lab A6): the current version filled, earlier ones a ring, both in the meta tone.
  const marker = (current: boolean) => <View aria-hidden style={{ width: MARKER_SIZE, height: MARKER_SIZE, borderRadius: MARKER_SIZE / 2,
    ...(current ? { backgroundColor: props.colors.secondary } : { borderWidth: 1.5, borderColor: props.colors.tertiary }) }} />;
  const column = props.sideBySide ? {
    width: 300, alignSelf: 'stretch' as const,
    ...(props.colors.divider ? { borderRightWidth: 1, borderRightColor: props.colors.divider } : {}),
  } : null;
  return <View testID="artifact-history:versions" style={column}>
    <ItemGroup title={props.title}>
      <Item testID="artifact-history:current" title={props.currentTitle} subtitle={props.currentSubtitle} leading={marker(true)}
        titleAccessory={Badge ? <Badge label={props.currentLabel} />
          : <Text style={{ fontSize: 11, fontWeight: '600', color: props.colors.secondary }}>{props.currentLabel}</Text>}
        showChevron={false} />
      {props.revisions.map(revision => <Item key={revision.bodyVersion}
        testID={`artifact-history:version:${revision.bodyVersion}`} title={revision.title} subtitle={revision.subtitle}
        detail={revision.detail} selected={revision.bodyVersion === props.selectedVersion} leading={marker(false)}
        onPress={() => props.onSelectVersion(revision.bodyVersion)} showChevron={!props.sideBySide} />)}
    </ItemGroup>
    {/* On the rows' text edge (sheet inset + row padding), so the note reads as the list's last line; beside
        the preview it closes the list column at its foot. */}
    <Text style={{ fontSize: 12, color: props.colors.tertiary, marginTop: props.sideBySide ? 'auto' : 8,
      ...(props.sideBySide ? { paddingTop: 8 } : {}),
      paddingHorizontal: HAPPIER_PAGE_METRICS.sheetInsetPx + HAPPIER_PAGE_METRICS.rowPaddingHorizontalPx }}>{props.retentionLabel}</Text>
  </View>;
}

const MARKER_SIZE = 7;
