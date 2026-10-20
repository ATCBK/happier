import * as React from 'react';
import { defineUiSurface } from '@happier-dev/plugin-ui';
import type { RenderSurface } from '@happier-dev/plugin-sdk/ui';
import { TriageLatestWidget } from './latestWidget.js';

export const renderSurface: RenderSurface = defineUiSurface(() => <TriageLatestWidget tasksOnly />);
