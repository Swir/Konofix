import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const sourcePath = path.resolve('scripts/test-node-runtime.ps1');
const source = fs.readFileSync(sourcePath, 'utf8');

function checkResolver(text) {
  const start = text.indexOf('function Get-ExpectedSourceCommit {');
  const end = text.indexOf('function Start-SmokeNode {', start);
  assert(start >= 0 && end > start, 'Runtime source resolver is missing');
  const resolver = text.slice(start, end);
  assert.doesNotMatch(resolver, /\$env:GITHUB_SHA\b/i, 'Synthetic PR merge SHA must not override checked-out source');
  assert.doesNotMatch(resolver, /\$LASTEXITCODE\b/i, 'Source resolver must not depend on ambient LASTEXITCODE under StrictMode');
  assert.match(resolver, /\$expectedPin = \$env:KONOFIX_SOURCE_SHA/);
  assert.match(resolver, /git rev-parse --verify HEAD/);
  assert.match(resolver, /\[string\]::Equals\(\$expectedPin, \$commit, \[System.StringComparison\]::Ordinal\)/);
  assert.match(resolver, /throw 'KONOFIX_SOURCE_SHA does not match the checked-out source commit\.'/);
  assert(resolver.indexOf('if ($artifactMode)') < resolver.indexOf('Push-Location'), 'Verified artifact metadata must remain independent of the enclosing checkout');
  assert.match(resolver, /\$commit = \[string\]\$buildInfo\.commit/);
  assert.match(resolver, /finally\s*{\s*Pop-Location\s*}/);
}

const netprobeSource = fs.readFileSync(path.resolve('src-tauri/src/bin/konofix-netprobe.rs'), 'utf8');

function checkNetprobeSmokeContract(smokeText, cliText) {
  const start = smokeText.indexOf('function Invoke-TransportProbe {');
  const end = smokeText.indexOf('$expectedSourceCommit = Get-ExpectedSourceCommit', start);
  assert(start >= 0 && end > start, 'Runtime Netprobe smoke function is missing');
  const probe = smokeText.slice(start, end);
  assert.match(cliText, /konofix-netprobe \[--timeout SEC\] <NODE_MULTIADDR>/, 'Netprobe CLI usage changed; update the smoke contract deliberately');
  assert.match(probe, /& \$probe --timeout 20 \$target/);
  assert.doesNotMatch(probe, /--transport|--target|--timeout-ms|--json/, 'Runtime smoke must not pass flags unsupported by konofix-netprobe');
  assert.match(probe, /\$evidence\.status -cne 'pass'/);
  assert.match(probe, /\$evidence\.expected_peer_id/);
  assert.match(probe, /\$evidence\.observed_peer_id/);
  assert.match(probe, /\$evidence\.protocol_version/);
  assert.match(probe, /\$evidence\.agent_version/);
  assert.match(smokeText, /-Transport 'quic-v1'/, 'QUIC smoke must use the evidence transport name emitted by Netprobe');
}

checkNetprobeSmokeContract(source, netprobeSource);

checkResolver(source);
assert.throws(() => checkResolver(source.replace('$expectedPin = $env:KONOFIX_SOURCE_SHA', '$expectedPin = $env:GITHUB_SHA')));
assert.throws(() => checkResolver(source.replace('git rev-parse --verify HEAD', 'git rev-parse HEAD')));
assert.throws(() => checkResolver(source.replace("throw 'KONOFIX_SOURCE_SHA does not match the checked-out source commit.'", 'return $expectedPin')));
assert.throws(() => checkResolver(source.replace('$commit = (& git rev-parse --verify HEAD 2>$null | Select-Object -First 1)', '$LASTEXITCODE = 0; $commit = (& git rev-parse --verify HEAD 2>$null | Select-Object -First 1)')));
console.log('Node runtime source binding: source checks and adversarial mutations PASS.');

// Evaluate the actual PowerShell function, not a JS translation of its policy.
// This runs before expensive builds through npm audit on the Windows runner.
const shell = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8', timeout: 15_000 });
if (shell.error?.code === 'ENOENT' && process.platform !== 'win32') {
  console.log('Node runtime source binding: PowerShell runtime cases SKIPPED (pwsh not installed); Windows CI must run them.');
} else {
  assert.equal(shell.status, 0, `PowerShell is required for resolver runtime cases: ${shell.stderr || shell.error || ''}`);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'konofix-source-binding-'));
  try {
    const repo = path.join(temp, 'checkout with spaces');
    const orphan = path.join(temp, 'no-checkout');
    fs.mkdirSync(repo);
    fs.mkdirSync(orphan);
    const git = args => {
      const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 15_000 });
      assert.equal(result.status, 0, `Fixture git failed: ${result.stderr}`);
      return result.stdout.trim();
    };
    git(['init', '-q']);
    git(['-c', 'user.name=Konofix Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'source fixture']);
    const head = git(['rev-parse', 'HEAD']);
    const fixture = path.join(temp, 'source-binding.ps1');
    fs.writeFileSync(fixture, String.raw`param([string]$SourcePath, [string]$FixtureRoot, [string]$OrphanRoot, [string]$Head)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$PSNativeCommandUseErrorActionPreference = $false
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($SourcePath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw 'Runtime smoke PowerShell does not parse.' }
$definitions = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Get-ExpectedSourceCommit' }, $true))
if ($definitions.Count -ne 1) { throw 'Expected exactly one production source resolver.' }
. ([scriptblock]::Create($definitions[0].Extent.Text))

function Assert-Commit([string]$Expected, [string]$Label) {
    $actual = Get-ExpectedSourceCommit
    if ($actual -cne $Expected) { throw "Resolver mismatch: $Label" }
    Write-Host "PASS: $Label"
}
function Assert-Rejected([string]$Label) {
    $rejected = $false
    try { Get-ExpectedSourceCommit | Out-Null } catch { $rejected = $true }
    if (-not $rejected) { throw "Resolver accepted invalid input: $Label" }
    Write-Host "PASS: $Label"
}

$projectRoot = $FixtureRoot
$artifactMode = $false
$buildInfo = $null
$env:KONOFIX_SOURCE_SHA = $null
$env:GITHUB_SHA = $null
$locationBefore = (Get-Location).Path
Assert-Commit $Head 'local checkout without CI environment'
$env:GITHUB_SHA = ('a' * 40)
Assert-Commit $Head 'synthetic PR merge SHA does not replace checked-out HEAD'
$env:KONOFIX_SOURCE_SHA = $Head
Assert-Commit $Head 'explicit exact-head pin matches checkout despite merge SHA'
$env:KONOFIX_SOURCE_SHA = ('b' * 40)
Assert-Rejected 'valid but stale source pin'
foreach ($invalid in @('short', ('C' * 40), (' ' + $Head), ($Head + ' '), ($Head + [char]10), ' ')) {
    $env:KONOFIX_SOURCE_SHA = $invalid
    Assert-Rejected 'non-canonical source pin'
}
if ((Get-Location).Path -cne $locationBefore) { throw 'Resolver did not restore working directory after failure.' }
$env:KONOFIX_SOURCE_SHA = $Head
$projectRoot = $OrphanRoot
Assert-Rejected 'environment pin cannot replace a missing checkout'
if ((Get-Location).Path -cne $locationBefore) { throw 'Failed git resolution leaked working directory.' }

$artifactMode = $true
$buildInfo = [pscustomobject]@{ commit = ('c' * 40) }
$env:KONOFIX_SOURCE_SHA = ('d' * 40)
Assert-Commit ('c' * 40) 'artifact metadata is authoritative without a checkout'
$projectRoot = $FixtureRoot
Assert-Commit ('c' * 40) 'artifact under another checkout retains its own source identity'
foreach ($invalid in @('unknown', ('E' * 40), '', ($Head + ' '), (' ' + $Head))) {
    $buildInfo = [pscustomobject]@{ commit = $invalid }
    Assert-Rejected 'invalid artifact source commit'
}
Write-Host 'Node runtime source resolver: actual PowerShell and real Git fixture cases PASS.'
exit 0
`);
    const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', fixture, sourcePath, repo, orphan, head], { encoding: 'utf8', timeout: 60_000 });
    if (result.stdout) process.stdout.write(result.stdout);
    assert.equal(result.status, 0, `Source resolver runtime regression: ${result.stderr || result.error || ''}`);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}