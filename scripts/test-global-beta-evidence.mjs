import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  validateGlobalBetaEvidence,
  validateGlobalBetaEvidencePackage,
} from './validate-global-beta-evidence.mjs';

const commit = '0123456789abcdef0123456789abcdef01234567';
const peers = [
  '12D3KooWQ1111111111111111111111111111111111111111111',
  '12D3KooWQ2222222222222222222222222222222222222222222',
  '12D3KooWQ3333333333333333333333333333333333333333333',
];
const requiredChecks = [
  'world_chat', 'rooms', 'reconnect', 'file_a_to_b_sha256', 'file_b_to_a_sha256',
  'tcp', 'quic_v1', 'relay', 'dcutr', 'cgnat',
];

function hash(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function loadEvidence(clients) {
  const tcpAttempted = Math.ceil(clients / 2);
  const quicAttempted = Math.floor(clients / 2);
  return {
    schema: 2,
    tool: 'konofix-global-beta-load',
    status: 'pass',
    clients,
    minimum_success_percent: 95,
    passed: clients,
    failed: 0,
    success_percent: 100,
    exact_build: {
      version: '0.4.2',
      source_commit: commit,
      netprobe_sha256: 'b'.repeat(64),
      netprobe_bytes: 123456,
    },
    node_health: {
      verified: true,
      peer_id: peers[0],
      version: '0.4.2',
      source_commit: commit,
      pre_timestamp_unix: 1_000_000,
      post_timestamp_unix: 1_000_060,
      pre_uptime_seconds: 10_000,
      post_uptime_seconds: 10_060,
    },
    tcp: { attempted: tcpAttempted, passed: tcpAttempted },
    quic: { attempted: quicAttempted, passed: quicAttempted },
  };
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'konofix-global-beta-evidence-'));
  const artifactBytes = Buffer.from('verified candidate artifact bytes');
  fs.writeFileSync(path.join(root, 'candidate.zip'), artifactBytes);
  const loadRuns = [50, 100, 250].map((clients) => {
    const fileName = `global-beta-load-${clients}.json`;
    const bytes = Buffer.from(`${JSON.stringify(loadEvidence(clients), null, 2)}\n`);
    fs.writeFileSync(path.join(root, fileName), bytes);
    return { clients, path: fileName, sha256: hash(bytes) };
  });

  const evidenceDir = path.join(root, 'evidence');
  fs.mkdirSync(evidenceDir);
  const evidence = {};
  for (const name of [...requiredChecks, 'failover']) {
    const relativePath = `evidence/${name}.txt`;
    const bytes = Buffer.from(`verified field evidence for ${name}\n`);
    fs.writeFileSync(path.join(root, relativePath), bytes);
    evidence[name] = { path: relativePath, sha256: hash(bytes) };
  }

  return { root, artifactSha256: hash(artifactBytes), loadRuns, evidence };
}

function validDocument(fixture) {
  const networks = ['net-a', 'net-b', 'net-c', 'net-d', 'net-e'];
  const countries = ['NO', 'PL', 'DE'];
  return {
    schema: 2,
    tool: 'konofix-global-beta-evidence',
    status: 'pass',
    candidate: {
      version: '0.4.2',
      source_commit: commit,
      artifact_path: 'candidate.zip',
      artifact_sha256: fixture.artifactSha256,
    },
    window: {
      started_utc: '2026-09-20T10:00:00Z',
      ended_utc: '2026-09-20T11:00:00Z',
      duration_seconds: 3600,
    },
    participants: peers.map((peer_id, index) => ({
      peer_id,
      network_id: index === 0 ? 'participant-net-a' : 'participant-net-b',
      country: countries[index],
    })),
    contact_paths: [
      { peer_id: peers[0], transport: 'tcp', address: `/dns/node-a.example/tcp/45555/p2p/${peers[0]}`, network_id: 'participant-net-a', reachable: true },
      { peer_id: peers[1], transport: 'relay', address: `/dns/node-b.example/tcp/45555/p2p/${peers[1]}/p2p-circuit`, network_id: 'participant-net-b', reachable: true },
    ],
    clients: Array.from({ length: 20 }, (_, index) => ({
      id: `client-${index + 1}`,
      network_id: networks[index % networks.length],
      country: countries[index % countries.length],
    })),
    load_runs: fixture.loadRuns.map((run) => ({ ...run })),
    checks: requiredChecks.map((name) => ({
      name,
      status: 'pass',
      evidence: { ...fixture.evidence[name] },
      ...(name.includes('sha256') ? { observed_sha256: 'c'.repeat(64) } : {}),
    })),
    failover: {
      lost_peer_id: peers[0],
      recovered_via_peer_ids: [peers[1]],
      discovery_recovered: true,
      chat_recovered: true,
      rooms_recovered: true,
      evidence: { ...fixture.evidence.failover },
    },
  };
}

function structuralFailure(mutator, pattern) {
  const fixture = createFixture();
  try {
    const document = validDocument(fixture);
    mutator(document);
    assert.throws(
      () => validateGlobalBetaEvidence(document, { expectedVersion: '0.4.2', expectedCommit: commit }),
      pattern,
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

function packageFailure(mutator, pattern) {
  const fixture = createFixture();
  try {
    const document = validDocument(fixture);
    mutator(document, fixture);
    assert.throws(
      () => validateGlobalBetaEvidencePackage(document, fixture.root, { expectedVersion: '0.4.2', expectedCommit: commit }),
      pattern,
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

{
  const fixture = createFixture();
  try {
    const document = validDocument(fixture);
    const summary = validateGlobalBetaEvidencePackage(document, fixture.root, { expectedVersion: '0.4.2', expectedCommit: commit });
    assert.equal(summary.schema, 2);
    assert.equal(summary.participant_nodes, 3);
    assert.equal(summary.participant_networks, 2);
    assert.equal(summary.reachable_contact_identities, 2);
    assert.equal(summary.clients, 20);
    assert.equal(summary.client_networks, 5);
    assert.equal(summary.countries, 3);
    assert.equal(summary.duration_seconds, 3600);
    assert.deepEqual(summary.load_clients, [50, 100, 250]);
    assert.equal(summary.load_artifacts.length, 3);
    assert.equal(summary.artifact_sha256, fixture.artifactSha256);
    assert.equal(summary.field_evidence_references, 11);
    assert.equal(summary.field_evidence_artifacts, 11);
    assert.equal(summary.field_evidence.length, 11);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

structuralFailure((doc) => { doc.schema = 1; }, /schema must equal 2/i);
structuralFailure((doc) => { doc.clients.pop(); }, /at least twenty real clients/i);
structuralFailure((doc) => { for (const client of doc.clients) client.network_id = 'only-one'; }, /five independent network IDs/i);
structuralFailure((doc) => { for (const client of doc.clients) client.country = 'NO'; }, /at least three countries/i);
structuralFailure((doc) => { doc.contact_paths = doc.contact_paths.slice(0, 1); }, /two distinct reachable/i);
structuralFailure((doc) => { doc.load_runs = doc.load_runs.filter((run) => run.clients !== 250); }, /250-client load evidence/i);
structuralFailure((doc) => { doc.window.ended_utc = '2026-09-20T10:59:59Z'; doc.window.duration_seconds = 3599; }, /at least 3600/i);
structuralFailure((doc) => { doc.checks = doc.checks.filter((check) => check.name !== 'rooms'); }, /required check 'rooms' is missing/i);
structuralFailure((doc) => { doc.checks.find((check) => check.name === 'file_a_to_b_sha256').observed_sha256 = 'bad'; }, /observed_sha256/i);
structuralFailure((doc) => { doc.checks.find((check) => check.name === 'rooms').evidence = 'free text'; }, /object with path and sha256/i);
structuralFailure((doc) => { doc.checks.find((check) => check.name === 'rooms').evidence.sha256 = 'bad'; }, /evidence.sha256/i);
structuralFailure((doc) => { doc.failover.recovered_via_peer_ids = [doc.failover.lost_peer_id]; }, /cannot use the participant/i);
structuralFailure((doc) => { doc.failover.rooms_recovered = false; }, /discovery, chat and room recovery/i);
structuralFailure((doc) => { doc.failover.evidence = 'free text'; }, /object with path and sha256/i);
structuralFailure((doc) => { doc.candidate.artifact_sha256 = 'B'.repeat(64); }, /artifact_sha256/i);
structuralFailure((doc) => { doc._template = true; }, /template manifests can never qualify/i);

packageFailure((doc) => { doc.candidate.artifact_path = '../candidate.zip'; }, /escapes the evidence manifest directory/i);
packageFailure((_doc, fixture) => { fs.appendFileSync(path.join(fixture.root, 'candidate.zip'), 'tamper'); }, /artifact SHA-256 mismatch/i);
packageFailure((doc, fixture) => { fs.appendFileSync(path.join(fixture.root, doc.load_runs[0].path), 'tamper'); }, /50-client load evidence SHA-256 mismatch/i);
packageFailure((doc, fixture) => {
  const entry = doc.load_runs.find((run) => run.clients === 100);
  const altered = loadEvidence(100);
  altered.exact_build.source_commit = 'f'.repeat(40);
  const bytes = Buffer.from(`${JSON.stringify(altered)}\n`);
  fs.writeFileSync(path.join(fixture.root, entry.path), bytes);
  entry.sha256 = hash(bytes);
}, /exact_build.source_commit does not match/i);
packageFailure((doc, fixture) => {
  const entry = doc.load_runs.find((run) => run.clients === 250);
  const altered = loadEvidence(250);
  altered.minimum_success_percent = 80;
  const bytes = Buffer.from(`${JSON.stringify(altered)}\n`);
  fs.writeFileSync(path.join(fixture.root, entry.path), bytes);
  entry.sha256 = hash(bytes);
}, /minimum_success_percent must be between 95 and 100/i);
packageFailure((doc, fixture) => {
  const entry = doc.load_runs.find((run) => run.clients === 50);
  const altered = loadEvidence(50);
  altered.node_health.verified = false;
  const bytes = Buffer.from(`${JSON.stringify(altered)}\n`);
  fs.writeFileSync(path.join(fixture.root, entry.path), bytes);
  entry.sha256 = hash(bytes);
}, /node_health.verified must be true/i);
packageFailure((doc) => {
  doc.checks.find((check) => check.name === 'rooms').evidence.path = '../outside.txt';
}, /escapes the evidence manifest directory/i);
packageFailure((doc, fixture) => {
  const ref = doc.checks.find((check) => check.name === 'world_chat').evidence;
  fs.appendFileSync(path.join(fixture.root, ref.path), 'tamper');
}, /checks.world_chat.evidence SHA-256 mismatch/i);
packageFailure((doc, fixture) => {
  fs.appendFileSync(path.join(fixture.root, doc.failover.evidence.path), 'tamper');
}, /failover.evidence SHA-256 mismatch/i);

console.log('Global Beta evidence validator self-tests passed: schema-v2 structure, exact candidate/load bytes, field-evidence bytes, stable health and failover gates are fail-closed.');
