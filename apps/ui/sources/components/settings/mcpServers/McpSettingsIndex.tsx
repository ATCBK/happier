import * as React from 'react';
import { useHappierCollectionIndexView } from '@happier-dev/plugin-ui/presentation';

import { useMcpAddRouteParams } from './add/useOpenMcpAddModal';
import { McpServerCollection } from './collection/McpServerCollection';
import { McpServersHome } from './home/McpServersHome';

/**
 * `/settings/mcp`. Beside the rail it is the selected "All servers" page: the homepage (P7 U7.11). Where no
 * rail shows (a phone), it is the server list itself, led by the homepage's map.
 */
export const McpSettingsIndex = React.memo(function McpSettingsIndex() {
  useMcpAddRouteParams();
  const view = useHappierCollectionIndexView();
  if (view === 'pending') return null;
  if (view === 'land') return <McpServersHome />;
  return <McpServerCollection variant="page" />;
});
