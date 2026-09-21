import fs from 'node:fs';
import * as tsNamespace from 'typescript';

const ts = tsNamespace.default ?? tsNamespace;

const source = fs.readFileSync('src/chat-expression.ts', 'utf8');
// TypeScript 7 no longer guarantees the historical compiler enums on the
// JavaScript API surface. These are the stable numeric compiler-option values
// for ES2022 module (7) and ES2022 target (9), so the test works with both the
// legacy JS compiler and the current TypeScript 7 package.
if (typeof ts.transpileModule !== 'function') {
  throw new Error('The installed TypeScript package does not expose transpileModule.');
}
const output = ts.transpileModule(source, {
  compilerOptions: { module: 7, target: 9 },
}).outputText;
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
if (mod.NICK_COLORS.length < 10 || mod.KONOFIX_EMOJI.length < 30) {
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
