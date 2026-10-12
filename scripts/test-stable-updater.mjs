import assert from 'node:assert/strict';
import fs from 'node:fs';

const { isStableVersion } = await import('../src/updater.ts');
assert.equal(isStableVersion('0.6.0'), true);
assert.equal(isStableVersion('2.0.1+build.9'), true);
assert.equal(isStableVersion('0.6.0-rc.1'), false, 'prereleases must never enter the stable updater');
assert.equal(isStableVersion('0.6.0-5'), false, 'alpha build identifiers must never enter the stable updater');

const frontend = fs.readFileSync('src/updater.ts', 'utf8');
const main = fs.readFileSync('src/main.ts', 'utf8');
const tauri = fs.readFileSync('src-tauri/tauri.conf.json', 'utf8');
const capability = fs.readFileSync('src-tauri/capabilities/main-events.json', 'utf8');
const workflow = fs.readFileSync('.github/workflows/stable-updater.yml', 'utf8');

assert.ok(frontend.indexOf('await callbacks.ask') < frontend.indexOf('update.downloadAndInstall'), 'user approval must happen before download and install');
assert.match(frontend, /restartAfterInstall:\s*true/);
assert.match(main, /window\.confirm\(t\('update\.available'/, 'the installed app must ask before every stable install');
assert.match(tauri, /releases\/latest\/download\/latest\.json/);
assert.match(tauri, /"pubkey":\s*"[A-Za-z0-9+/=]+"/, 'a public signature verification key must be embedded');
assert.match(capability, /"updater:default"/);
assert.match(workflow, /release:\s*[\s\S]*types:\s*\[published\]/);
assert.match(workflow, /prerelease == false/);
assert.match(workflow, /Package version '[^']*' is not stable SemVer|is not stable SemVer/);
assert.match(workflow, /TAURI_SIGNING_PRIVATE_KEY/);
assert.match(workflow, /\.nsis\.zip/);
assert.match(workflow, /\.sig/);
assert.match(workflow, /latest\.json/);
assert.match(workflow, /git merge-base --is-ancestor HEAD origin\/main/);

console.log('Stable updater test passed: signed exact-tag releases, stable-only policy and explicit user consent.');
