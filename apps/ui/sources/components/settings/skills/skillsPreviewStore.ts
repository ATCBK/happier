import { createCapabilityPreview } from '@/components/capabilities/reach/capabilityPreview';

/** The skill the person is pointing at (a hovered or focused rail row): the homepage's map lights its dots. */
const preview = createCapabilityPreview();

export const setPreviewedSkill = preview.set;
export const usePreviewedSkill = preview.use;
