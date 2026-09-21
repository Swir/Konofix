import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const sourcePath = path.resolve('src/chat-expression.ts');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'konofix-chat-expression-'));
try {
  // TypeScript 7 no longer exposes the historical programmatic compiler API
  // from the package root. Exercise the committed source through the supported
  // tsc CLI instead of depending on removed JS API internals.
  const result = spawnSync(
    'npx',
    [
      'tsc', sourcePath,
      '--target', 'ES2022',
      '--module', 'ES2022',
      '--moduleResolution', 'bundler',
      '--outDir', tempDir,
      '--skipLibCheck',
      '--pretty', 'false',
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      shell: process.platform === 'win32',
    },
  );
  if (result.status !== 0) {
    throw new Error(`Unable to compile chat-expression.ts for tests:\n${result.stdout}${result.stderr}`);
  }

  const output = fs.readFileSync(path.join(tempDir, 'chat-expression.js'), 'utf8');
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(output).toString('base64')}`;
  const mod = await import(moduleUrl);

  const expectedCodes = [':D', ':)', ':-)', ':*', ':P', 'XD', ';)', ':(', '<3', ':fire:', ':robot:'];
  for (const code of expectedCodes) {
    if (!mod.KONOFIX_EMOJI.some(item => item.code === code)) {
      throw new Error(`Missing required Konofix emoji code: ${code}`);
    }
  }

  const rendered = mod.renderChatText('Hi :) :D :* <script>');
  if (!rendered.includes('🙂') || !rendered.includes('😄') || !rendered.includes('😘')) {
    throw new Error('Common emoticons are not rendered as Konofix emoji.');
  }
  if (rendered.includes('<script>')) {
    throw new Error('Chat renderer allowed raw HTML.');
  }
  const url = 'https://example.test/:D';
  if (!mod.renderChatText(url).includes(url)) {
    throw new Error('URL-like text was corrupted by emoticon conversion.');
  }
  if (mod.normalizeNickColor('#ffffff') !== mod.DEFAULT_NICK_COLOR) {
    throw new Error('Unapproved nickname colors must fail closed to the default.');
  }
  const uniqueGlyphs = new Set(mod.KONOFIX_EMOJI.map(item => item.glyph));
  if (mod.NICK_COLORS.length < 10 || mod.KONOFIX_EMOJI.length < 30 || uniqueGlyphs.size < 28) {
    throw new Error('Expression palette is unexpectedly small.');
  }

  const rust = fs.readFileSync('src-tauri/src/lib.rs', 'utf8');
  const rustPalette = [...rust.matchAll(/"#[0-9A-F]{6}"/g)].map(match => match[0].slice(1, -1));
  for (const item of mod.NICK_COLORS) {
    if (!rustPalette.includes(item.value)) {
      throw new Error(`Frontend/backend nickname palette drift: ${item.value}`);
    }
  }
  console.log(`Konofix expression tests passed: ${mod.KONOFIX_EMOJI.length} emoji aliases, ${mod.NICK_COLORS.length} nickname colors.`);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
