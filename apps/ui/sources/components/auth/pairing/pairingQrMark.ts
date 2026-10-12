import { tryCreateQRMatrix } from '@/components/qr/qrMatrix';

/**
 * Whether the pairing code carries the Happier mark: quartile correction (which recovers up to a quarter
 * of the code) at no density cost, i.e. the same module grid as the admission level (`medium`).
 */
export function isPairingQrMarked(link: string): boolean {
    const admitted = tryCreateQRMatrix(link, 'medium');
    const sturdier = tryCreateQRMatrix(link, 'quartile');
    return admitted.ok && sturdier.ok && sturdier.matrix.size === admitted.matrix.size;
}
