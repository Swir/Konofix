import fs from 'node:fs';
import path from 'node:path';

const target = path.resolve(process.argv[2] ?? 'src/main.ts');
const source = fs.readFileSync(target, 'utf8').replaceAll('\r\n', '\n');

const fail = (message) => {
  console.error(`BOOTSTRAP PERSISTENCE POLICY ERROR: ${message}`);
  process.exit(1);
};

const handlerStart = "modal.querySelector('#addBootstrap')?.addEventListener('click', async () => {";
const handlerEnd = "modal.querySelectorAll<HTMLButtonElement>('[data-remove-bootstrap]')";
const start = source.indexOf(handlerStart);
if (start < 0) fail('could not locate the add-bootstrap handler.');
const end = source.indexOf(handlerEnd, start + handlerStart.length);
if (end < 0) fail('could not locate the end of the add-bootstrap handler.');

const handler = source.slice(start, end);
const nextDeclaration = 'const next = [...loadBootstraps(), address];';
const invokeLine = "await invoke('add_bootstrap', { address });";
const saveLine = 'saveBootstraps(next);';

for (const required of [nextDeclaration, 'if (state.connected) {', invokeLine, saveLine]) {
  if (!handler.includes(required)) fail(`required bootstrap persistence guard is missing: ${required}`);
}

const saveMatches = handler.match(/saveBootstraps\(next\);/g) ?? [];
if (saveMatches.length !== 1) {
  fail(`the add-bootstrap handler must persist the candidate exactly once; found ${saveMatches.length}.`);
}

const validationBlock = /if \(state\.connected\) \{\s*try \{\s*await invoke\('add_bootstrap', \{ address \}\);\s*\}\s*catch \(e\) \{\s*alert\(String\(e\)\);\s*return;\s*\}\s*\}\s*saveBootstraps\(next\);/m;
if (!validationBlock.test(handler)) {
  fail('connected-mode persistence must happen only after successful backend validation, and the validation failure path must return without saving.');
}

const nextIndex = handler.indexOf(nextDeclaration);
const connectedIndex = handler.indexOf('if (state.connected) {');
const invokeIndex = handler.indexOf(invokeLine);
const saveIndex = handler.indexOf(saveLine);
const closeIndex = handler.indexOf('close();', saveIndex);
if (!(nextIndex < connectedIndex && connectedIndex < invokeIndex && invokeIndex < saveIndex)) {
  fail('bootstrap persistence ordering is invalid: candidate -> connected validation -> persistence is required.');
}
if (closeIndex < 0 || saveIndex > closeIndex) {
  fail('the validated bootstrap must be persisted before the modal is closed/refreshed.');
}

console.log('Bootstrap persistence policy passed: connected additions are saved only after backend validation succeeds.');
