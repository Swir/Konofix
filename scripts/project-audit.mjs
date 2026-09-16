import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const fail = (message) => {
  console.error(`AUDIT ERROR: ${message}`);
  process.exitCode = 1;
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
    if (polishChars.test(read(file))) fail(`${file} contains Polish-specific characters; CI text must remain English.`);
  }
}

// Keep the npm install policy synchronized with the repository's actual lockfile state.
// This prevents CI from silently returning to the broken `npm ci`/npm-cache configuration
// before a real package-lock.json exists.
const windowsWorkflowPath = '.github/workflows/windows-ci.yml';
if (fs.existsSync(path.join(root, windowsWorkflowPath))) {
  const workflow = read(windowsWorkflowPath);
  const hasNpmLock = fs.existsSync(path.join(root, 'package-lock.json'));
  const usesNpmCi = /\brun:\s*npm ci(?:\s|$)/m.test(workflow);
  const usesNpmInstall = /\brun:\s*npm install(?:\s|$)/m.test(workflow);
  const enablesNpmCache = /^\s*cache:\s*['"]?npm['"]?\s*$/m.test(workflow);

  if (hasNpmLock) {
    if (!usesNpmCi) fail('package-lock.json exists, but Windows CI is not using npm ci.');
    if (usesNpmInstall) fail('package-lock.json exists, but Windows CI still contains npm install.');
    console.log('Frontend dependency policy: lockfile present and npm ci enforced.');
  } else {
    if (usesNpmCi) fail('Windows CI uses npm ci without a committed package-lock.json.');
    if (!usesNpmInstall) fail('Windows CI must use npm install until package-lock.json is committed.');
    if (enablesNpmCache) fail('Windows CI must not enable setup-node npm cache without package-lock.json.');
    console.log('Frontend dependency policy: no lockfile; compatible npm install path enforced.');
  }
}

const main = read('src/main.ts');
const polishLiteralCount = (main.match(/[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/g) || []).length;
console.log(`Runtime localization migration indicator: ${polishLiteralCount} Polish-specific characters remain in src/main.ts.`);
console.log('This indicator is informational until all runtime strings are migrated to typed translation keys.');

if (!process.exitCode) console.log('Project audit passed.');
