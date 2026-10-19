import { describe, expect, it } from 'vitest';

import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { FollowPolicyEditor, type FollowPolicyEditorReceiver } from './FollowPolicyEditor.js';
import { PluginUiProvider } from './PluginUiProvider.js';

const EVENTS = [
  { id: 'needs_you.decision', delivery: 'interrupt' },
  { id: 'needs_you.approval', delivery: 'interrupt' },
  { id: 'needs_you.blocked', delivery: 'interrupt' },
  { id: 'finished', delivery: 'quiet' },
  { id: 'message', delivery: 'off' },
] as const;

function mountEditor(preset: string, receiver?: FollowPolicyEditorReceiver) {
  const context = createSurfaceContext();
  return mountThroughReactNativeWeb(
    <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
      <FollowPolicyEditor
        {...(receiver === undefined ? {} : { receiver })}
        preset={preset}
        presets={['everything', 'important', 'quiet', 'custom']}
        events={EVENTS}
        onSelectPreset={() => undefined}
        onSetDelivery={() => undefined}
      />
    </PluginUiProvider>,
  );
}

describe('FollowPolicyEditor receiver', () => {
  it('names the channels for a person unless told otherwise', () => {
    const view = mountEditor('important');
    const text = view.container.textContent ?? '';
    expect(text).toContain('Push');
    expect(text).toContain('Inbox');
    expect(text).not.toContain('Wake');
    view.unmount();
  });

  it('names the same channels Wake and Next turn for a Session receiver, in presets and in Custom', () => {
    const preset = mountEditor('important', 'session');
    const presetText = preset.container.textContent ?? '';
    expect(presetText).toContain('Wake');
    expect(presetText).toContain('Next turn');
    expect(presetText).not.toContain('Push');
    expect(presetText).not.toContain('Inbox');
    preset.unmount();

    const custom = mountEditor('custom', 'session');
    const customText = custom.container.textContent ?? '';
    expect(customText).toContain('Wake');
    expect(customText).toContain('Next turn');
    expect(customText).not.toContain('Push');
    expect(customText).not.toContain('Inbox');
    custom.unmount();
  });
});
