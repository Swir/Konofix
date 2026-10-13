import { build } from 'vite';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

// Build the existing Windows WORLD module and its locked nostr-tools dependency.
// No Tauri desktop APIs, handwritten DEX, CDN scripts or experimental crypto.
const root = process.cwd();
const out = resolve(root, 'mobile/titanium/web-dist');
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await build({
  configFile: false,
  build: {
    outDir: out,
    emptyOutDir: false,
    target: 'es2020',
    sourcemap: false,
    lib: {
      entry: resolve(root, 'mobile/titanium/client.js'),
      name: 'KonofixAndroidBundle',
      formats: ['iife'],
      fileName: () => 'client.js',
    },
  },
});
const code = (await readFile(resolve(out, 'client.js'), 'utf8')).replace(/<\/script/gi, '<\\/script');
const template = await readFile(resolve(root, 'mobile/titanium/index.html'), 'utf8');
if (template.split('<!-- APP_SCRIPT -->').length !== 2) throw new Error('Expected exactly one script placeholder');
await writeFile(resolve(out, 'index.html'), template.replace('<!-- APP_SCRIPT -->', () => `<script>${code}</script>`));
console.log('Bundled the shared WORLD transport into the offline Android interface.');
