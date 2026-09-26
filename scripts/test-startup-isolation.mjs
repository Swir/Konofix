import fs from 'node:fs';

const index = fs.readFileSync('index.html', 'utf8');
const main = fs.readFileSync('src/main.ts', 'utf8');
const loader = fs.readFileSync('src/startup-ui-loader.ts', 'utf8');

const directOptionalScripts = [
  '/src/secure-ui.ts',
  '/src/private-audio-ui.ts',
  '/src/room-audio-ui.ts',
  '/src/voice-mute-ui.ts',
  '/src/test-updater-ui.ts',
];

for (const src of directOptionalScripts) {
  if (index.includes(`<script type="module" src="${src}"></script>`)) {
    throw new Error(`Optional UI module must not be a direct HTML entry: ${src}`);
  }
}

for (const required of [
  '<script type="module" src="/src/main.ts"></script>',
  '<script type="module" src="/src/startup-ui-loader.ts"></script>',
  'konofix.lastStartupError',
  'konofix-module-error',
  'konofixCoreReady',
]) {
  if (!index.includes(required)) throw new Error(`Startup guard/index contract missing: ${required}`);
}

for (const modulePath of [
  './secure-ui',
  './private-audio-ui',
  './room-audio-ui',
  './voice-mute-ui',
  './test-updater-ui',
]) {
  if (!loader.includes(`import('${modulePath}')`)) {
    throw new Error(`Startup loader must dynamically import ${modulePath}`);
  }
}

if (!loader.includes('requestAnimationFrame') || !loader.includes('await module.load()')) {
  throw new Error('Optional UI modules must load after first paint and be isolated one-by-one.');
}
if (!main.includes('aria-label="Konofix core ready"') || !main.includes("dataset.konofixCoreReady = 'true'")) {
  throw new Error('Core login UI must expose the startup-ready marker for runtime qualification.');
}

console.log('Startup isolation contract passed.');
