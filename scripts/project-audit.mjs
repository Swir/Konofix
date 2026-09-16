import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const fail = (message) => {
  console.error(`AUDIT ERROR: ${message}`);
  process.exitCode = 1;
};
const isTracked = (file) => {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', '--', file], {
      cwd: root,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
};

const pkg = JSON.parse(read('package.json'));
const tauri = JSON.parse(read('src-tauri/tauri.conf.json'));
const cargo = read('src-tauri/Cargo.toml');
const cargoVersion = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1];

if (!cargoVersion) fail('Could not read Cargo package version.');
if (pkg.version !== tauri.version || pkg.version !== cargoVersion) {
  fail(`Version mismatch: package.json=${pkg.version}, tauri.conf.json=${tauri.version}, Cargo.toml=${cargoVersion}`);
} else {
  console.log(`Version consistency: ${pkg.version}`);
}

const i18n = read('src/i18n.ts');
if (!/return\s+'en';/.test(i18n)) fail('English locale fallback is missing.');
if (!/SUPPORTED[^\n]*'en'/.test(i18n)) fail('English is not present in the supported locale list.');
console.log('Localization fallback: English is configured.');

const polishChars = /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/;
const docs = ['README.md', 'ROADMAP.md', 'CHANGELOG.md'];
if (fs.existsSync(path.join(root, 'docs'))) {
  for (const name of fs.readdirSync(path.join(root, 'docs'))) {
    if (name.endsWith('.md')) docs.push(`docs/${name}`);
  }
}

for (const file of docs) {
  const text = read(file);
  if (polishChars.test(text)) fail(`${file} contains Polish-specific characters; repository documentation must remain English.`);
}

const englishOnlyOperationalFiles = ['src-tauri/src/bin/konofix-node.rs'];
for (const name of fs.readdirSync(root)) {
  if (/\.bat$/i.test(name)) englishOnlyOperationalFiles.push(name);
}
const scriptsDir = path.join(root, 'scripts');
if (fs.existsSync(scriptsDir)) {
  for (const name of fs.readdirSync(scriptsDir)) {
    if (/\.(ps1|bat)$/i.test(name)) englishOnlyOperationalFiles.push(`scripts/${name}`);
  }
}

for (const file of englishOnlyOperationalFiles) {
  if (polishChars.test(read(file))) {
    fail(`${file} contains Polish-specific characters; operational tooling and Node CLI must remain English.`);
  }
}

const workflowDir = path.join(root, '.github', 'workflows');
if (fs.existsSync(workflowDir)) {
  for (const name of fs.readdirSync(workflowDir)) {
    if (!/\.ya?ml$/i.test(name)) continue;
    const file = `.github/workflows/${name}`;
    const workflowText = read(file);
    if (polishChars.test(workflowText)) fail(`${file} contains Polish-specific characters; CI text must remain English.`);

    for (const match of workflowText.matchAll(/^\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/gm)) {
      const action = match[1];
      if (action.startsWith('./') || action.startsWith('docker://')) continue;
      const separator = action.lastIndexOf('@');
      const actionName = separator > 0 ? action.slice(0, separator) : action;
      const actionRef = separator > 0 ? action.slice(separator + 1) : '';
      if (!/^[0-9a-f]{40}$/i.test(actionRef)) {
        fail(`${file} uses floating GitHub Action ref ${action}; pin ${actionName} to a full commit SHA.`);
      }
    }
  }
}

// Keep the npm install policy synchronized with the repository's committed lockfile state.
// npm install can create an untracked package-lock.json in the CI workspace, so filesystem
// presence alone is not evidence that a deterministic lockfile is part of the repository.
const windowsWorkflowPath = '.github/workflows/windows-ci.yml';
if (fs.existsSync(path.join(root, windowsWorkflowPath))) {
  const workflow = read(windowsWorkflowPath);
  const hasCommittedNpmLock = isTracked('package-lock.json');
  const hasWorkingNpmLock = fs.existsSync(path.join(root, 'package-lock.json'));
  const usesNpmCi = /\brun:\s*npm ci(?:\s|$)/m.test(workflow);
  const usesNpmInstall = /\brun:\s*npm install(?:\s|$)/m.test(workflow);
  const disablesGeneratedLock = /\brun:\s*npm install[^\r\n]*--package-lock=false(?:\s|$)/m.test(workflow);
  const enablesNpmCache = /^\s*cache:\s*['"]?npm['"]?\s*$/m.test(workflow);

  if (hasCommittedNpmLock) {
    if (!usesNpmCi) fail('A committed package-lock.json exists, but Windows CI is not using npm ci.');
    if (usesNpmInstall) fail('A committed package-lock.json exists, but Windows CI still contains npm install.');
    console.log('Frontend dependency policy: committed lockfile present and npm ci enforced.');
  } else {
    if (usesNpmCi) fail('Windows CI uses npm ci without a committed package-lock.json.');
    if (!usesNpmInstall) fail('Windows CI must use npm install until package-lock.json is committed.');
    if (!disablesGeneratedLock) fail('No-lockfile Windows CI must pass --package-lock=false so npm install cannot create transient lockfile state.');
    if (enablesNpmCache) fail('Windows CI must not enable setup-node npm cache without a committed package-lock.json.');
    if (hasWorkingNpmLock) console.log('Frontend dependency policy: ignoring an untracked/generated package-lock.json; Git-tracked state remains authoritative.');
    console.log('Frontend dependency policy: no committed lockfile; compatible npm install path enforced.');
  }
}

const main = read('src/main.ts');
const polishLiteralCount = (main.match(/[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/g) || []).length;
console.log(`Runtime localization migration indicator: ${polishLiteralCount} Polish-specific characters remain in src/main.ts.`);
console.log('This indicator is informational until all runtime strings are migrated to typed translation keys.');

if (!process.exitCode) console.log('Project audit passed.');
