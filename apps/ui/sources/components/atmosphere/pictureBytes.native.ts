import { File } from 'expo-file-system';

/** Native byte ingress shared by picture storage and its derived renders. */
export async function readPictureBase64(data: Blob | string): Promise<string> {
    if (typeof data === 'string') {
        if (data.startsWith('data:')) {
            const comma = data.indexOf(',');
            if (comma < 0 || !data.slice(0, comma).endsWith(';base64')) throw new Error('Atmosphere picture data URI must contain base64 bytes');
            return data.slice(comma + 1);
        }
        return new File(data).base64();
    }
    // React Native Blob has no arrayBuffer; FileReader owns the native conversion.
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error ?? new Error('Atmosphere picture could not be read'));
        reader.onload = () => {
            if (typeof reader.result !== 'string') { reject(new Error('Atmosphere picture has no bytes')); return; }
            resolve(reader.result.slice(reader.result.indexOf(',') + 1));
        };
        reader.readAsDataURL(data);
    });
}
