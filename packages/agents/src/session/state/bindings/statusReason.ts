import { z } from 'zod/mini';
import type { SessionStateBinding } from '../_types.js';

/** An annotation only; the metadata CAS owns replacement and clearing. */
export const sessionStatusReasonBinding: SessionStateBinding<'display.statusReason'> = {
  read: metadata => {
    const work = metadata.work;
    return { value: work && typeof work === 'object' && 'statusReason' in work && typeof work.statusReason === 'string'
      ? work.statusReason : null, updatedAt: null };
  },
  write: (metadata, update) => {
    const reason = z.nullable(z.string()).parse(update.value);
    const previousWork = metadata.work && typeof metadata.work === 'object' && !Array.isArray(metadata.work)
      ? metadata.work : {};
    if (reason === null) {
      if (!('statusReason' in previousWork)) return metadata;
      const { statusReason: _previous, ...work } = previousWork;
      return { ...metadata, work };
    }
    if ('statusReason' in previousWork && previousWork.statusReason === reason) return metadata;
    return { ...metadata, work: { ...previousWork, statusReason: reason } };
  },
};
