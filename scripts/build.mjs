import { mkdir, rm, cp, stat, readdir, readFile, writeFile } from 'node:fs/promises';
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

const youtubeContentPartsDir = path.join(dist, 'youtube-content.parts');
const youtubeContentFile = path.join(dist, 'youtube-content.js');
if (await exists(youtubeContentPartsDir)) {
  const parts = (await readdir(youtubeContentPartsDir)).filter((name) => name.endsWith('.js')).sort();
  const combined = (await Promise.all(parts.map((name) => readFile(path.join(youtubeContentPartsDir, name), 'utf8')))).join('');
  await writeFile(youtubeContentFile, combined);
  await rm(youtubeContentPartsDir, { recursive: true, force: true });
}

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

if (!(await exists(manifest))) throw new Error('Build failed: dist/manifest.json missing');
if (!(await exists(youtubeContentFile))) throw new Error('Build failed: dist/youtube-content.js missing');
if (!(await exists(kuromojiJs))) throw new Error('Build failed: missing Kuromoji runtime. Run npm install first.');
if (!(await exists(kuromojiBase))) throw new Error('Build failed: missing Kuromoji dictionary. Run npm install first.');

console.log('Built extension to dist/');
console.log('Load dist/ in chrome://extensions or edge://extensions');
