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
const assertDependencyMap = (manifestMap, lockMap, label) => {
  const expected = manifestMap ?? {};
  const actual = lockMap ?? {};
  const expectedKeys = Object.keys(expected).sort();
  const actualKeys = Object.keys(actual).sort();
  if (JSON.stringify(expectedKeys) !== JSON.stringify(actualKeys)) {
    fail(`package-lock.json ${label} keys do not match package.json.`);
    return;
  }
  for (const name of expectedKeys) {
    if (actual[name] !== expected[name]) {
      fail(`package-lock.json ${label} entry for ${name} does not match package.json.`);
    }
  }
};

const pkg = JSON.parse(read('package.json'));
const tauri = JSON.parse(read('src-tauri/tauri.conf.json'));
const cargo = read('src-tauri/Cargo.toml');
const cargoName = cargo.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
const cargoVersion = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1];

if (!cargoName) fail('Could not read Cargo package name.');
if (!cargoVersion) fail('Could not read Cargo package version.');
if (pkg.version !== tauri.version || pkg.version !== cargoVersion) {
  fail(`Version mismatch: package.json=${pkg.version}, tauri.conf.json=${tauri.version}, Cargo.toml=${cargoVersion}`);
} else {
  console.log(`Version consistency: ${pkg.version}`);
}

const i18n = read('src/i18n.ts');
if (!/return\s+'en';/.test(i18n)) fail('English locale fallback is missing.');
if (!/SUPPORTED[^\n]*'en'/.test(i18n)) fail('English is not present in the supported locale list.');
if (!/export\s+type\s+MessageKey\s*=/.test(i18n)) fail('Typed MessageKey export is missing from src/i18n.ts.');
if (!/export\s+function\s+t\s*\(/.test(i18n)) fail('Typed t() translation API is missing from src/i18n.ts.');
if (/MutationObserver|translateElement|dynamicTranslate/.test(i18n)) {
  fail('Legacy DOM/source-text localization compatibility code is still present in src/i18n.ts.');
}
console.log('Localization fallback: English is configured and typed message-key API is active.');

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

const roadmapText = read('ROADMAP.md');
const readmeText = read('README.md');
const milestoneHeadingMatch = roadmapText.match(/^## \d+\.\d+\.\d+ — Real Internet Test[^\n]*$/m);
const activeMilestoneHeading = milestoneHeadingMatch?.[0] ?? '';
const milestoneStart = activeMilestoneHeading ? roadmapText.indexOf(activeMilestoneHeading) : -1;
if (milestoneStart < 0) {
  fail('Could not locate the canonical Real Internet Test milestone in ROADMAP.md.');
} else {
  const milestoneEnd = roadmapText.indexOf('\n## ', milestoneStart + activeMilestoneHeading.length);
  const milestone = roadmapText.slice(milestoneStart, milestoneEnd < 0 ? undefined : milestoneEnd);
  const completedTasks = (milestone.match(/^- \[[xX]\] /gm) || []).length;
  const openTasks = (milestone.match(/^- \[ \] /gm) || []).length;
  const totalTasks = completedTasks + openTasks;

  if (totalTasks === 0) {
    fail('The active roadmap milestone contains no checklist tasks.');
  } else {
    const progressPercent = ((completedTasks / totalTasks) * 100).toFixed(1);
    const progressSummary = `Real Internet Test milestone: ${progressPercent}% complete`;
    const taskSummary = `${completedTasks} of ${totalTasks} tasks complete`;

    if (!readmeText.includes(progressSummary)) fail(`README.md progress must say "${progressSummary}".`);
    if (!roadmapText.includes(progressSummary)) fail(`ROADMAP.md progress must say "${progressSummary}".`);
    if (!readmeText.includes(taskSummary)) fail(`README.md task count must say "${taskSummary}".`);
    if (!roadmapText.includes(taskSummary)) fail(`ROADMAP.md task count must say "${taskSummary}".`);

    console.log(`Roadmap progress consistency: ${completedTasks}/${totalTasks} (${progressPercent}%).`);
  }
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
  const pinsNpmCacheToLock = /^\s*cache-dependency-path:\s*['"]?package-lock\.json['"]?\s*$/m.test(workflow);
  const generatesLockCandidate = /Generate frontend lockfile candidate|--package-lock-only/.test(workflow);

  if (hasCommittedNpmLock) {
    let lock;
    try {
      lock = JSON.parse(read('package-lock.json'));
    } catch (error) {
      fail(`Committed package-lock.json is invalid JSON: ${error.message}`);
    }
    if (lock) {
      if (lock.lockfileVersion !== 3) fail(`package-lock.json lockfileVersion must be 3; found ${lock.lockfileVersion}.`);
      const lockRoot = lock.packages?.[''];
      if (!lockRoot) {
        fail('package-lock.json is missing the root package entry.');
      } else {
        if (lockRoot.name !== pkg.name || lockRoot.version !== pkg.version) {
          fail('package-lock.json root package name/version does not match package.json.');
        }
        assertDependencyMap(pkg.dependencies, lockRoot.dependencies, 'dependencies');
        assertDependencyMap(pkg.devDependencies, lockRoot.devDependencies, 'devDependencies');
      }
    }

    if (!usesNpmCi) fail('A committed package-lock.json exists, but Windows CI is not using npm ci.');
    if (usesNpmInstall) fail('A committed package-lock.json exists, but Windows CI still contains npm install.');
    if (!enablesNpmCache) fail('A committed package-lock.json exists, but setup-node npm caching is not enabled.');
    if (!pinsNpmCacheToLock) fail('setup-node npm cache must use package-lock.json as cache-dependency-path.');
    if (generatesLockCandidate) fail('Windows CI must not regenerate a frontend lockfile after package-lock.json is committed.');
    console.log('Frontend dependency policy: committed lockfile matches package.json; npm ci and lockfile-keyed cache are enforced.');
  } else {
    if (usesNpmCi) fail('Windows CI uses npm ci without a committed package-lock.json.');
    if (!usesNpmInstall) fail('Windows CI must use npm install until package-lock.json is committed.');
    if (!disablesGeneratedLock) fail('No-lockfile Windows CI must pass --package-lock=false so npm install cannot create transient lockfile state.');
    if (enablesNpmCache) fail('Windows CI must not enable setup-node npm cache without a committed package-lock.json.');
    if (hasWorkingNpmLock) console.log('Frontend dependency policy: ignoring an untracked/generated package-lock.json; Git-tracked state remains authoritative.');
    console.log('Frontend dependency policy: no committed lockfile; compatible npm install path enforced.');
  }
}

// Rust dependency resolution is a release input, not merely provenance captured after compilation.
const cargoLockPath = 'src-tauri/Cargo.lock';
if (!isTracked(cargoLockPath)) {
  fail('src-tauri/Cargo.lock must be committed so Rust dependency resolution is deterministic.');
} else {
  const cargoLock = read(cargoLockPath);
  if (!/^version\s*=\s*4\s*$/m.test(cargoLock)) {
    fail('src-tauri/Cargo.lock must use Cargo lockfile format version 4.');
  }
  if (cargoName && cargoVersion) {
    const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rootPackage = new RegExp(`\\[\\[package\\]\\][\\s\\S]*?^name\\s*=\\s*"${escapeRegex(cargoName)}"\\s*$[\\s\\S]*?^version\\s*=\\s*"${escapeRegex(cargoVersion)}"\\s*$`, 'm');
    if (!rootPackage.test(cargoLock)) {
      fail(`src-tauri/Cargo.lock does not contain the expected root package ${cargoName} ${cargoVersion}.`);
    }
  }

  const lockedCargoCommandFiles = [
    '.github/workflows/windows-ci.yml',
    'scripts/check.ps1',
    'scripts/build-windows.ps1',
    'build-node.bat',
  ];
  for (const file of lockedCargoCommandFiles) {
    for (const line of read(file).split(/\r?\n/)) {
      if (/\bcargo\s+(?:metadata|test|check|build)\b/.test(line) && !/--locked\b/.test(line)) {
        fail(`${file} contains a Rust dependency-resolving Cargo command without --locked: ${line.trim()}`);
      }
    }
  }

  const workflow = read(windowsWorkflowPath);
  if (!/Rust lockfile metadata gate/.test(workflow) || !/cargo metadata --locked/.test(workflow)) {
    fail('Windows CI must validate the committed Cargo.lock with cargo metadata --locked before production builds.');
  }
  if (!/test-public-node-readiness\.ps1/.test(workflow)) {
    fail('Windows CI must run public Node readiness adversarial self-tests.');
  }
  if (!/'check-public-node-readiness\.ps1'/.test(workflow)) {
    fail('Windows test artifacts must include the public Node readiness validator.');
  }

  const verifier = read('scripts/verify-release.ps1');
  if (!/src-tauri\\Cargo\.lock/.test(verifier) || !/Packaged Cargo\.lock does not match the committed Rust build input/.test(verifier)) {
    fail('Release verification must bind packaged Cargo.lock to committed src-tauri/Cargo.lock.');
  }
  console.log('Rust dependency policy: committed Cargo.lock, --locked resolution and packaged-input verification are enforced.');
}

const main = read('src/main.ts');
const polishLiteralCount = (main.match(/[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/g) || []).length;
if (polishLiteralCount !== 0) {
  fail(`Runtime localization migration regressed: ${polishLiteralCount} Polish-specific characters remain in src/main.ts.`);
}
if (!/from\s+['"]\.\/i18n['"]/.test(main) || !/\bt\(['"][a-z0-9_.]+['"]/.test(main)) {
  fail('src/main.ts must consume the typed localization API.');
}
console.log('Runtime localization migration: typed message keys enforced; no Polish UI literals remain in src/main.ts.');

// Stable promotion must be cryptographically and operationally scoped to one exact source revision,
// not merely to a mutable semantic package version.
const buildScript = read('src-tauri/build.rs');
const nodeSource = read('src-tauri/src/bin/konofix-node.rs');
const healthValidator = read('scripts/check-node-health.ps1');
const soakValidator = read('scripts/validate-node-soak.ps1');
const reportGenerator = read('scripts/new-network-test-report.ps1');
const evidenceValidator = read('scripts/validate-network-test-report.ps1');
const reportEditor = read('scripts/set-network-test-result.ps1');
const releaseGate = read('scripts/release-gate.ps1');
const evidenceSelfTest = read('scripts/test-network-evidence-gate.ps1');
const healthSelfTest = read('scripts/test-node-health.ps1');
const soakSelfTest = read('scripts/test-node-soak.ps1');

if (!/KONOFIX_SOURCE_COMMIT/.test(buildScript)) fail('Rust build metadata no longer exports KONOFIX_SOURCE_COMMIT.');
if (!/source_commit/.test(nodeSource) || !/schema:\s*2/.test(nodeSource)) fail('Konofix Node must emit schema-v2 health telemetry containing source_commit.');
if (!/ExpectedSourceCommit/.test(healthValidator) || !/source_commit/.test(healthValidator)) fail('Node health validation no longer pins exact source commits.');
if (!/ExpectedSourceCommit/.test(soakValidator) || !/source_commit/.test(soakValidator)) fail('Node soak validation no longer pins exact source commits.');
if (!/schema_version\s*=\s*3/.test(reportGenerator) || !/source_commit/.test(reportGenerator)) fail('Network report generation must emit schema-v3 exact source-commit evidence.');
if (!/schema_version\s+-ne\s+3/.test(evidenceValidator) || !/ExpectedSourceCommit/.test(evidenceValidator)) fail('Network evidence validation must enforce schema v3 and exact source commits.');
if (!/Stable promotion requires a check_evidence object/.test(evidenceValidator) || !/64-character SHA-256 digest/.test(evidenceValidator)) fail('Stable promotion evidence validation must require concrete PASS notes and full file-transfer SHA-256 digests.');
if (!/requires a non-empty evidence note/.test(reportEditor) || !/64-character SHA-256 digest/.test(reportEditor)) fail('Network report editing must reject evidence-free PASS/FAIL results and file PASS results without a full digest.');
if (!/ExpectedSourceCommit/.test(releaseGate) || !/ExpectedSourceCommit\s*=\s*\$targetSourceCommit/.test(releaseGate)) fail('Release gate must propagate the exact target source commit into promotion evidence validation.');
if (!/wrong source commit|mixed source commits/i.test(evidenceSelfTest)) fail('Network evidence self-tests must cover source-commit mismatch attacks.');
if (!/promotion PASS without check_evidence object/i.test(evidenceSelfTest) || !/file PASS without explicit SHA-256 digest/i.test(evidenceSelfTest)) fail('Network evidence self-tests must cover evidence-free PASS and missing file-digest promotion attacks.');
if (!/wrong expected source commit/i.test(healthSelfTest)) fail('Node health self-tests must cover wrong source-commit pins.');
if (!/source commit changed during soak/i.test(soakSelfTest)) fail('Node soak self-tests must cover source-commit drift.');
console.log('Exact-build provenance and evidence quality: promotion is commit-bound, evidence-rich, and file digests are explicit.');

if (!process.exitCode) console.log('Project audit passed.');
