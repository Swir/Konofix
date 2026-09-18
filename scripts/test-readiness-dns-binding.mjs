import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const checker = path.resolve('scripts/check-readiness-dns-binding.mjs');
const sourcePath = path.resolve('scripts/check-public-node-readiness.ps1');
const source = fs.readFileSync(sourcePath, 'utf8').replaceAll('\r\n', '\n');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'konofix-readiness-dns-binding-'));

const run = (content) => {
  const candidate = path.join(tempDir, 'check-public-node-readiness.ps1');
  fs.writeFileSync(candidate, content, 'utf8');
  return spawnSync(process.execPath, [checker, candidate], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
};

const mutateOnce = (text, from, to) => {
  const first = text.indexOf(from);
  if (first < 0) throw new Error(`Test fixture source not found: ${from}`);
  if (text.indexOf(from, first + from.length) >= 0) {
    throw new Error(`Test fixture source is not unique: ${from}`);
  }
  return text.slice(0, first) + to + text.slice(first + from.length);
};

const baseline = run(source);
if (baseline.status !== 0) {
  console.error(baseline.stdout);
  console.error(baseline.stderr);
  throw new Error('Canonical readiness validator must pass DNS-binding policy before adversarial mutations run.');
}

const cases = [
  {
    name: 'hostname is re-resolved during TCP reachability',
    from: '$task = $client.ConnectAsync($targetAddress, $PortValue)',
    to: '$task = $client.ConnectAsync($HostName, $PortValue)',
    expected: 'required DNS-binding guard is missing',
  },
  {
    name: 'QUIC performs a second DNS resolution',
    from: '$quic = Parse-Bootstrap -Address $QuicBootstrap -ResolveDns $false',
    to: '$quic = Parse-Bootstrap -Address $QuicBootstrap -ResolveDns $true',
    expected: 'required DNS-binding guard is missing',
  },
  {
    name: 'TCP skips the authoritative DNS snapshot',
    from: '$tcp = Parse-Bootstrap -Address $TcpBootstrap -ResolveDns $true',
    to: '$tcp = Parse-Bootstrap -Address $TcpBootstrap -ResolveDns $false',
    expected: 'required DNS-binding guard is missing',
  },
  {
    name: 'structured probe-target evidence removed',
    from: '    tcp_probe_targets = @($tcpProbeTargets)\n',
    to: '',
    expected: 'required DNS-binding guard is missing',
  },
];

for (const testCase of cases) {
  const mutated = mutateOnce(source, testCase.from, testCase.to);
  const result = run(mutated);
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (result.status === 0) {
    throw new Error(`Mutation '${testCase.name}' unexpectedly passed the readiness DNS-binding checker.`);
  }
  if (!output.includes(testCase.expected)) {
    throw new Error(`Mutation '${testCase.name}' failed for the wrong reason. Expected '${testCase.expected}', got:\n${output}`);
  }
}

fs.rmSync(tempDir, { recursive: true, force: true });
console.log(`Readiness DNS binding adversarial policy tests passed (${cases.length} mutations rejected).`);
