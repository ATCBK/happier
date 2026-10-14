import { createCapabilityPreview } from '@/components/capabilities/reach/capabilityPreview';

/** The server the person is pointing at in the rail: the homepage lights its tether and says how it reaches. */
const preview = createCapabilityPreview();

export const setPreviewedMcpServer = preview.set;
export const usePreviewedMcpServer = preview.use;
