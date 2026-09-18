import fs from 'node:fs';
import path from 'node:path';

const target = path.resolve(process.argv[2] ?? 'scripts/check-public-node-readiness.ps1');
const source = fs.readFileSync(target, 'utf8').replaceAll('\r\n', '\n');

const fail = (message) => {
  console.error(`READINESS DNS BINDING POLICY ERROR: ${message}`);
  process.exit(1);
};

const required = [
  'function Parse-Bootstrap([string]$Address, [bool]$ResolveDns)',
  '$tcp = Parse-Bootstrap -Address $TcpBootstrap -ResolveDns $true',
  '$quic = Parse-Bootstrap -Address $QuicBootstrap -ResolveDns $false',
  '$tcpProbeTargets = @(Get-ValidatedTcpProbeTargets -ParsedTcp $tcp)',
  'function Test-TcpReachability([string[]]$ValidatedAddresses, [int]$PortValue, [int]$TimeoutMs)',
  '$task = $client.ConnectAsync($targetAddress, $PortValue)',
  'tcp_probe_targets = @($tcpProbeTargets)',
  'tcp_reachable_address = $tcpReachableAddress',
];

for (const snippet of required) {
  if (!source.includes(snippet)) fail(`required DNS-binding guard is missing: ${snippet}`);
}

if (source.includes('ConnectAsync($HostName')) {
  fail('TCP reachability must not connect by hostname after DNS validation.');
}
if (source.includes('[System.Net.Dns]::GetHostAddresses')) {
  fail('the readiness wrapper must delegate DNS resolution to internet-test.ps1 instead of performing an unbound second lookup.');
}

const trueMatches = source.match(/Parse-Bootstrap -Address \$TcpBootstrap -ResolveDns \$true/g) ?? [];
const falseMatches = source.match(/Parse-Bootstrap -Address \$QuicBootstrap -ResolveDns \$false/g) ?? [];
if (trueMatches.length !== 1 || falseMatches.length !== 1) {
  fail(`paired bootstrap parsing must have exactly one resolving TCP call and one non-resolving QUIC call; found TCP=${trueMatches.length}, QUIC=${falseMatches.length}.`);
}

const parseTcp = source.indexOf('$tcp = Parse-Bootstrap -Address $TcpBootstrap -ResolveDns $true');
const parseQuic = source.indexOf('$quic = Parse-Bootstrap -Address $QuicBootstrap -ResolveDns $false');
const probeTargets = source.indexOf('$tcpProbeTargets = @(Get-ValidatedTcpProbeTargets -ParsedTcp $tcp)');
const reachability = source.indexOf('Test-TcpReachability -ValidatedAddresses $tcpProbeTargets');
if (!(parseTcp >= 0 && parseTcp < parseQuic && parseQuic < probeTargets && probeTargets < reachability)) {
  fail('readiness ordering must be resolve TCP once -> parse paired QUIC without DNS -> freeze validated targets -> probe only those targets.');
}

console.log('Readiness DNS binding policy passed: one validated DNS snapshot feeds direct-IP TCP reachability and structured evidence.');
