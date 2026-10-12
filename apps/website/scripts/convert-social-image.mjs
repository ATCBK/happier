#!/usr/bin/env node
/**
 * Convert the GitHub social preview image to the website's og:image format.
 * 
 * Source: .github/header.png (3168x1500, 2.112:1)
 * Target: public/images/og.png (1200x630, 1.905:1)
 * 
 * The source is wider than the target, so we scale to fit the width and extend
 * the background at top and bottom to reach 630px height.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SOURCE = path.resolve(ROOT, '..', '..', '.github', 'header.png');
const OUTPUT = path.join(ROOT, 'public', 'images', 'og.png');

const TARGET_WIDTH = 1200;
const TARGET_HEIGHT = 630;

async function main() {
    // Load the source image to get its dimensions
    const source = sharp(SOURCE);
    const metadata = await source.metadata();
    
    console.log(`Source: ${metadata.width}x${metadata.height} (${(metadata.width / metadata.height).toFixed(3)}:1)`);
    console.log(`Target: ${TARGET_WIDTH}x${TARGET_HEIGHT} (${(TARGET_WIDTH / TARGET_HEIGHT).toFixed(3)}:1)`);
    
    // Scale the source to fit the target width
    const scaledHeight = Math.round((metadata.height / metadata.width) * TARGET_WIDTH);
    console.log(`After scaling to ${TARGET_WIDTH}px wide: ${TARGET_WIDTH}x${scaledHeight}`);
    
    // Calculate how much padding we need at top and bottom
    const totalPadding = TARGET_HEIGHT - scaledHeight;
    const topPadding = Math.floor(totalPadding / 2);
    const bottomPadding = totalPadding - topPadding;
    
    console.log(`Padding: ${topPadding}px top, ${bottomPadding}px bottom`);
    
    // Sample the background color from the middle-top (the dark gradient area)
    const pixel = await sharp(SOURCE)
        .extract({ left: Math.floor(metadata.width / 2), top: 10, width: 1, height: 1 })
        .raw()
        .toBuffer();
    
    const bg = { r: pixel[0], g: pixel[1], b: pixel[2], alpha: 1 };
    console.log(`Background: rgba(${bg.r}, ${bg.g}, ${bg.b}, ${bg.alpha})`);
    
    // Scale the source image
    const scaled = await source
        .resize(TARGET_WIDTH, scaledHeight, { fit: 'fill' })
        .png()
        .toBuffer();
    
    // Create the output with padding
    await sharp({
        create: {
            width: TARGET_WIDTH,
            height: TARGET_HEIGHT,
            channels: 4,
            background: bg
        }
    })
    .composite([{
        input: scaled,
        top: topPadding,
        left: 0
    }])
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
