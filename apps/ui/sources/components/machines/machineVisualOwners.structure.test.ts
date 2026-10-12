import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/** Drawing libraries only the shared chart, meter and ring owners may import (MPG-24/25). */
const FORBIDDEN_DRAWING_IMPORT = /from\s+['"](?:react-native-svg|@shopify\/react-native-skia)(?:\/[^'"]*)?['"]|require\(\s*['"](?:react-native-svg|@shopify\/react-native-skia)/;

export function findForbiddenDrawingImports(files: ReadonlyArray<Readonly<{ path: string; source: string }>>): string[] {
    return files.filter(file => FORBIDDEN_DRAWING_IMPORT.test(file.source)).map(file => file.path);
}

const machinesDirectory = fileURLToPath(new URL('.', import.meta.url));
/** Machine-resources surfaces outside `components/machines/**` (the rail popover). */
const MACHINE_SURFACE_FILES = [fileURLToPath(new URL('../navigation/shell/sidebarFooter/SidebarMachinesPopoverContent.tsx', import.meta.url))];

function listSourceFiles(directory: string): string[] {
    return readdirSync(directory).flatMap((entry) => {
        const path = join(directory, entry);
        if (statSync(path).isDirectory()) return listSourceFiles(path);
        return /\.(?:ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [path] : [];
    });
}

describe('machine resources draw only through the shared visual owners', () => {
    it('finds a drawing library imported straight into a machines surface', () => {
        expect(findForbiddenDrawingImports([
            { path: 'planted.tsx', source: "import Svg, { Path } from 'react-native-svg';" },
            { path: 'skia.tsx', source: "import { Canvas } from '@shopify/react-native-skia';" },
            { path: 'owner.tsx', source: "import { CapacityRing } from '@/components/ui/progress/CapacityRing';" },
        ])).toEqual(['planted.tsx', 'skia.tsx']);
    });

    it('keeps every machines component and the Machines popover on the chart, meter and ring owners', () => {
        const files = [...listSourceFiles(machinesDirectory), ...MACHINE_SURFACE_FILES]
            .map(path => ({ path, source: readFileSync(path, 'utf8') }));
        expect(files.length).toBeGreaterThan(10);
        expect(findForbiddenDrawingImports(files)).toEqual([]);
    });
});
