import assert from 'node:assert/strict';
import fs from 'node:fs';

globalThis.localStorage = {
  getItem(key) { return key === 'konofix.locale' ? null : null; },
  setItem() {},
};
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { languages: ['pl-PL'], language: 'pl-PL' },
});
globalThis.document = { documentElement: { lang: '' } };

const { currentLocale, resolveLocale, t } = await import('../src/i18n.ts');
assert.equal(currentLocale, 'pl', 'first launch must select the Windows/browser system language');
assert.equal(resolveLocale('nb-NO'), 'no', 'Windows Norwegian Bokmål must map to the supported Norwegian locale');
assert.equal(resolveLocale('nn_NO'), 'no', 'Windows Norwegian Nynorsk must map to the supported Norwegian locale');
assert.equal(resolveLocale('uk-UA'), 'uk');
assert.equal(resolveLocale('fr-FR'), 'fr');
assert.match(t('voice.wantToSpeak'), /Chcę mówić/);

const source = fs.readFileSync('src/i18n.ts', 'utf8');
for (const locale of ['PL', 'NO', 'DE', 'FR', 'ES', 'UK']) {
  const start = source.indexOf(`const ${locale}: Dictionary`);
  const end = source.indexOf('\n};', start);
  const dictionary = source.slice(start, end);
  for (const key of ['voice.worldTitle', 'voice.wantToSpeak', 'voice.roomTitle', 'voice.joinRoom']) {
    assert.ok(dictionary.includes(`'${key}'`), `${locale} must translate ${key}`);
  }
}

console.log('Language test passed: automatic system selection and seven localized voice interfaces.');
