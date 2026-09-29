// Copies design/mockups/ into dist/mockups/ after `astro build` so the five
// candidate UI directions are viewable on the deployed site. Delete this
// script and the mockups folder once a direction has been chosen and built.
import { cp, mkdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const src = path.join(root, 'design', 'mockups');
const dest = path.join(root, 'dist', 'mockups');

try {
  await stat(src);
} catch {
  console.log('[copy-mockups] no design/mockups folder, skipping');
  process.exit(0);
}

await mkdir(dest, { recursive: true });
await cp(src, dest, { recursive: true });
console.log(`[copy-mockups] copied ${path.relative(root, src)} -> ${path.relative(root, dest)}`);
