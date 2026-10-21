import * as React from 'react';
import { pictureStore } from '../pictureStore';
import type { BuiltinPicture, PictureInfo } from '../pictureStore.types';

type Bytes = Blob | string;

function useStoreRevision() {
  return React.useSyncExternalStore(
    pictureStore.subscribe,
    pictureStore.getRevision,
    () => 0,
  );
}

/** A built-in's picker thumbnail; null until it is cached (a failed download stays null for this visit). */
export function useBuiltinThumbnail(picture: BuiltinPicture | null): Bytes | null {
  const [bytes, setBytes] = React.useState<Readonly<{
    id: string;
    bytes: Bytes;
  }> | null>(null);
  React.useEffect(() => {
    if (!picture) return;
    let disposed = false;
    void pictureStore.ensureBuiltinThumbnail(picture).then(
      (next) => {
        if (!disposed) setBytes({ id: picture.id, bytes: next });
      },
      () => {},
    );
    return () => {
      disposed = true;
    };
  }, [picture]);
  return picture && bytes?.id === picture.id ? bytes.bytes : null;
}

/** A stored picture on this device: still being read, here with its full bytes, or not on this device. */
export type StoredPicture =
  | Readonly<{ status: 'loading' }>
  | Readonly<{ status: 'present'; bytes: Bytes }>
  | Readonly<{ status: 'missing' }>;

const LOADING: StoredPicture = { status: 'loading' };
const MISSING: StoredPicture = { status: 'missing' };

export function useStoredPicture(localId: string | null): StoredPicture {
  const revision = useStoreRevision();
  const [read, setRead] = React.useState<Readonly<{
    localId: string;
    picture: StoredPicture;
  }> | null>(null);
  React.useEffect(() => {
    if (localId === null) return;
    let disposed = false;
    void pictureStore.get(localId).then(
      (record) => {
        if (!disposed)
          setRead({ localId, picture: record ? { status: 'present', bytes: record.data } : MISSING });
      },
      () => {
        if (!disposed) setRead({ localId, picture: MISSING });
      },
    );
    return () => {
      disposed = true;
    };
  }, [localId, revision]);
  return localId !== null && read?.localId === localId ? read.picture : LOADING;
}

/** A stored picture's full bytes (a user picture on this device), or null when it is not here. */
export function useStoredPictureBytes(localId: string | null): Bytes | null {
  const picture = useStoredPicture(localId);
  return picture.status === 'present' ? picture.bytes : null;
}

/** The user pictures kept on this device, oldest first. */
export function useUserPictures(): readonly PictureInfo[] {
  const revision = useStoreRevision();
  const [pictures, setPictures] = React.useState<readonly PictureInfo[]>([]);
  React.useEffect(() => {
    let disposed = false;
    void pictureStore.list().then(
      (list) => {
        if (!disposed)
          setPictures(
            list
              .filter((info) => info.kind === 'user')
              .sort((a, b) => a.createdAtMs - b.createdAtMs),
          );
      },
      () => {},
    );
    return () => {
      disposed = true;
    };
  }, [revision]);
  return pictures;
}

/** An image URI for stored bytes: an object URL for a browser Blob (revoked with it), a file URI as is. */
export function usePictureUri(bytes: Bytes | null): string | null {
  const uri = React.useMemo(
    () =>
      bytes === null
        ? null
        : typeof bytes === 'string'
          ? bytes
          : URL.createObjectURL(bytes),
    [bytes],
  );
  React.useEffect(
    () => () => {
      if (uri && typeof bytes !== 'string') URL.revokeObjectURL(uri);
    },
    [bytes, uri],
  );
  return uri;
}
