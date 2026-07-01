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

async function assembleParts(targetFile) {
  const partsDir = path.join(dist, `${targetFile}.parts`);
  if (!(await exists(partsDir))) return;
  const parts = (await readdir(partsDir)).filter((name) => name.endsWith('.part')).sort();
  const combined = (await Promise.all(parts.map((name) => readFile(path.join(partsDir, name), 'utf8')))).join('');
  await writeFile(path.join(dist, targetFile), combined);
  await rm(partsDir, { recursive: true, force: true });
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(src, dist, { recursive: true });

for (const target of ['youtube-content.js', 'background.js', 'udemy-main.js', 'options.html']) {
  await assembleParts(target);
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
const youtubeContentFile = path.join(dist, 'youtube-content.js');
const backgroundFile = path.join(dist, 'background.js');
const udemyMainFile = path.join(dist, 'udemy-main.js');
const kuromojiJs = path.join(dist, 'vendor', 'kuromoji', 'kuromoji.js');
const kuromojiBase = path.join(dist, 'vendor', 'kuromoji', 'dict', 'base.dat.gz');

if (!(await exists(manifest))) throw new Error('Build failed: dist/manifest.json missing');
if (!(await exists(youtubeContentFile))) throw new Error('Build failed: dist/youtube-content.js missing');
if (!(await exists(backgroundFile))) throw new Error('Build failed: dist/background.js missing');
if (!(await exists(udemyMainFile))) throw new Error('Build failed: dist/udemy-main.js missing');
if (!(await exists(kuromojiJs))) throw new Error('Build failed: missing Kuromoji runtime. Run npm install first.');
if (!(await exists(kuromojiBase))) throw new Error('Build failed: missing Kuromoji dictionary. Run npm install first.');

console.log('Built extension to dist/');
console.log('Load dist/ in chrome://extensions or edge://extensions');
