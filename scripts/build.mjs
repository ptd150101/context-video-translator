import { mkdir, rm, cp, stat } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const src = path.join(root, 'src');
const dist = path.join(root, 'dist');

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(src, dist, { recursive: true });

// Prefer a fresh npm-installed kuromoji when available, but keep the bundled
// src/vendor copy as the offline fallback. This makes `npm run build` safe even
// when the user has not run `npm install`.
const kuromojiBuild = path.join(root, 'node_modules', 'kuromoji', 'build', 'kuromoji.js');
const kuromojiDict = path.join(root, 'node_modules', 'kuromoji', 'dict');
const vendorDir = path.join(dist, 'vendor', 'kuromoji');
if (await exists(kuromojiBuild)) {
  await mkdir(vendorDir, { recursive: true });
  await cp(kuromojiBuild, path.join(vendorDir, 'kuromoji.js'));
}
if (await exists(kuromojiDict)) {
  await mkdir(path.join(vendorDir, 'dict'), { recursive: true });
  await cp(kuromojiDict, path.join(vendorDir, 'dict'), { recursive: true });
}

const manifest = path.join(dist, 'manifest.json');
const kuromojiJs = path.join(dist, 'vendor', 'kuromoji', 'kuromoji.js');
const kuromojiBase = path.join(dist, 'vendor', 'kuromoji', 'dict', 'base.dat.gz');

if (!(await exists(manifest))) {
  throw new Error('Build failed: dist/manifest.json missing');
}
if (!(await exists(kuromojiJs))) {
  throw new Error('Build failed: dist/vendor/kuromoji/kuromoji.js missing. The bundled src/vendor folder may have been removed.');
}
if (!(await exists(kuromojiBase))) {
  throw new Error('Build failed: dist/vendor/kuromoji/dict/base.dat.gz missing. The bundled Kuromoji dictionary may have been removed.');
}

console.log('Built extension to dist/');
console.log('Load this folder in chrome://extensions -> Developer mode -> Load unpacked');
