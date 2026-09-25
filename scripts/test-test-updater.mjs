import fs from 'node:fs';
import assert from 'node:assert/strict';

const index = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const ui = fs.readFileSync(new URL('../src/test-updater-ui.ts', import.meta.url), 'utf8');
const rust = fs.readFileSync(new URL('../src-tauri/src/test_updater.rs', import.meta.url), 'utf8');
const lib = fs.readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');

assert.match(index, /src\/test-updater-ui\.ts/, 'desktop shell must load the test updater UI');
assert.match(ui, /invoke<TestUpdateInfo>\('check_test_update'\)/, 'UI must check updates through the trusted Tauri command');
assert.match(ui, /invoke\('install_test_update'\)/, 'UI must install updates through the trusted Tauri command');
assert.match(ui, /setInterval\([^]*10 \* 60 \* 1000\)/, 'test updater must re-check periodically');
assert.match(rust, /beta\/0\.6\.0-audio-calls/, 'test updater must remain pinned to the 0.6 audio branch');
assert.match(rust, /status=success/, 'test updater must only consider successful Windows CI runs');
assert.match(rust, /artifact_sha256/, 'test updater must bind downloads to the GitHub artifact digest');
assert.match(rust, /sha256_file\(&zip\)/, 'downloaded artifact ZIP must be hashed before extraction');
assert.match(rust, /BUILD_INFO\.json/, 'installer provenance must be verified against BUILD_INFO.json');
assert.match(rust, /bundle\/nsis\//, 'test updater must select the NSIS installer from the verified bundle');
assert.match(rust, /NIGHTLY_BASE/, 'test updater may use the anonymous Actions artifact bridge');
assert.doesNotMatch(rust, /releases\/latest|releases\/download|create.*release/i, 'test updater must not depend on or publish GitHub Releases');
assert.match(lib, /check_test_update/, 'Tauri command registry must expose update checks');
assert.match(lib, /install_test_update/, 'Tauri command registry must expose verified test update installation');

console.log('Verified 0.6 test updater contract checks passed.');
