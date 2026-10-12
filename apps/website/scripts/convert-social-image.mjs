#!/usr/bin/env node
/**
 * Convert the GitHub social preview image to the website's og:image format.
 * 
 * Source: scripts/assets/social-preview-source.png (3072x1500, 2.048:1)
 * Design: 'Start coding anywhere. Continue everywhere.' with desktop and phones
 * Target: public/images/og.png (1200x630, 1.905:1)
 * 
 * Method: Crop-to-fill approach to avoid visible bands and corner artifacts:
 * 1. Inset-crop 28px on every side (removes white rounded corners and border)
 * 2. Center-crop width to 1200:630 ratio (~2750px wide after inset)
 * 3. Lanczos-resize to final 1200x630
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
// Use the current GitHub social preview as source
const SOURCE = path.join(HERE, 'assets', 'social-preview-source.png');
const OUTPUT = path.join(ROOT, 'public', 'images', 'og.png');

const TARGET_WIDTH = 1200;
const TARGET_HEIGHT = 630;
const INSET = 28; // Remove white rounded corners and border

async function main() {
    // Load the source image to get its dimensions
    const source = sharp(SOURCE);
    const metadata = await source.metadata();
    
    console.log(`Source: ${metadata.width}x${metadata.height} (${(metadata.width / metadata.height).toFixed(3)}:1)`);
    console.log(`Target: ${TARGET_WIDTH}x${TARGET_HEIGHT} (${(TARGET_WIDTH / TARGET_HEIGHT).toFixed(3)}:1)`);
    
    // Step 1: Inset-crop to remove the white corners and border
    const insetWidth = metadata.width - (INSET * 2);
    const insetHeight = metadata.height - (INSET * 2);
    console.log(`After ${INSET}px inset: ${insetWidth}x${insetHeight}`);
    
    // Step 2: Calculate center-crop dimensions for target aspect ratio
    const targetRatio = TARGET_WIDTH / TARGET_HEIGHT;
    const insetRatio = insetWidth / insetHeight;
    
    let cropWidth, cropHeight, cropLeft, cropTop;
    
    if (insetRatio > targetRatio) {
        // Source is wider than target - crop width, keep height
        cropHeight = insetHeight;
        cropWidth = Math.round(cropHeight * targetRatio);
        cropLeft = INSET + Math.round((insetWidth - cropWidth) / 2);
        cropTop = INSET;
    } else {
        // Source is taller than target - crop height, keep width
        cropWidth = insetWidth;
        cropHeight = Math.round(cropWidth / targetRatio);
        cropLeft = INSET;
        cropTop = INSET + Math.round((insetHeight - cropHeight) / 2);
    }
    
    console.log(`Center-crop to ${cropWidth}x${cropHeight} at (${cropLeft}, ${cropTop})`);
    
    // Step 3: Extract the cropped region and resize with Lanczos
    await sharp(SOURCE)
        .extract({ left: cropLeft, top: cropTop, width: cropWidth, height: cropHeight })
        .resize(TARGET_WIDTH, TARGET_HEIGHT, {
            kernel: 'lanczos3',
            fit: 'fill'
        })
        .png({ compressionLevel: 9, palette: false })
        .toFile(OUTPUT);
    
    const stats = await import('node:fs/promises').then(m => m.stat(OUTPUT));
    console.log(`\nWritten: ${OUTPUT}`);
    console.log(`Size: ${(stats.size / 1024).toFixed(0)} KB`);
    
    if (stats.size > 1_500_000) {
        console.warn(`Warning: File is ${stats.size} bytes — may be too large for some social platforms`);
    }
}

await main();
