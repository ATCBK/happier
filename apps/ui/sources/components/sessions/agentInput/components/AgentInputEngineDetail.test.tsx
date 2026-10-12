import React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { installAgentInputCommonModuleMocks } from '../agentInputTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installAgentInputCommonModuleMocks();

vi.mock('@/components/ui/text/Text', () => ({
  Text: 'Text',
}));

vi.mock('@/components/sessions/pickers/OptionPickerOverlay', () => ({
  OptionPickerOverlay: (props: Record<string, unknown>) =>
    React.createElement('OptionPickerOverlay', props, null),
}));

describe('AgentInputEngineDetail', () => {
  it('does not render an empty model section when no model content or probe is provided', async () => {
    const { AgentInputEngineDetail } = await import('./AgentInputEngineDetail');

    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<AgentInputEngineDetail />);
    });

    expect(tree?.toJSON()).toBeNull();
  });

  it('keeps the model section mounted while a model probe is active', async () => {
    const { AgentInputEngineDetail } = await import('./AgentInputEngineDetail');

    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <AgentInputEngineDetail
          modelProbe={{ phase: 'loading', onRefresh: () => {} }}
        />,
      );
    });

    expect(tree?.root.findByType('OptionPickerOverlay')).toBeTruthy();
  });

  it('hands the composer apply timing and notes to a model surface that replaces the default one', async () => {
    const { AgentInputEngineDetail } = await import('./AgentInputEngineDetail');
    const { SessionModelApplyTimingContext } = await import('@/components/sessions/modelPicker/SessionModelSourceBrowseHandoff');
    let received: unknown = 'unset';
    function Override() {
      received = React.useContext(SessionModelApplyTimingContext);
      return null;
    }

    await act(async () => {
      renderer.create(
        <AgentInputEngineDetail
          modelContentOverride={<Override />}
          modelApplyTiming="Applies from your next message"
          modelNotes={['Kept for resume']}
        />,
      );
    });

    expect(received).toEqual({ timing: 'Applies from your next message', notes: ['Kept for resume'] });
  });
});
