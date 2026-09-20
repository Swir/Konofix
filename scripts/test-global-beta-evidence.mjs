import assert from 'node:assert/strict';
import { validateGlobalBetaEvidence } from './validate-global-beta-evidence.mjs';

const commit = '0123456789abcdef0123456789abcdef01234567';
const digest = 'a'.repeat(64);
const peers = [
  '12D3KooWQ1111111111111111111111111111111111111111111',
  '12D3KooWQ2222222222222222222222222222222222222222222',
  '12D3KooWQ3333333333333333333333333333333333333333333',
];

function validDocument() {
  const networks = ['net-a', 'net-b', 'net-c', 'net-d', 'net-e'];
  const countries = ['NO', 'PL', 'DE'];
  return {
    schema: 1,
    tool: 'konofix-global-beta-evidence',
    status: 'pass',
    candidate: {
      version: '0.4.2',
      source_commit: commit,
      artifact_sha256: digest,
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
    load_runs: [50, 100, 250].map((clients) => ({
      clients,
      status: 'pass',
      node_health_verified: true,
      version: '0.4.2',
      source_commit: commit,
      path: `global-beta-load-${clients}.json`,
      sha256: digest,
    })),
    checks: [
      'world_chat',
      'rooms',
      'reconnect',
      'file_a_to_b_sha256',
      'file_b_to_a_sha256',
      'tcp',
      'quic_v1',
      'relay',
      'dcutr',
      'cgnat',
    ].map((name) => ({
      name,
      status: 'pass',
      evidence: `${name} observed by independent testers`,
      ...(name.includes('sha256') ? { observed_sha256: digest } : {}),
    })),
    failover: {
      lost_peer_id: peers[0],
      recovered_via_peer_ids: [peers[1]],
      discovery_recovered: true,
      chat_recovered: true,
      rooms_recovered: true,
      evidence: 'peer-a was removed; clients converged through peer-b and continued WORLD/room traffic',
    },
  };
}

function expectFailure(mutator, pattern) {
  const document = validDocument();
  mutator(document);
  assert.throws(
    () => validateGlobalBetaEvidence(document, { expectedVersion: '0.4.2', expectedCommit: commit }),
    pattern,
  );
}

const summary = validateGlobalBetaEvidence(validDocument(), { expectedVersion: '0.4.2', expectedCommit: commit });
assert.equal(summary.participant_nodes, 3);
assert.equal(summary.participant_networks, 2);
assert.equal(summary.reachable_contact_identities, 2);
assert.equal(summary.clients, 20);
assert.equal(summary.client_networks, 5);
assert.equal(summary.countries, 3);
assert.equal(summary.duration_seconds, 3600);
assert.deepEqual(summary.load_clients, [50, 100, 250]);

expectFailure((doc) => { doc.clients.pop(); }, /at least twenty real clients/i);
expectFailure((doc) => { for (const client of doc.clients) client.network_id = 'only-one'; }, /five independent network IDs/i);
expectFailure((doc) => { for (const client of doc.clients) client.country = 'NO'; }, /at least three countries/i);
expectFailure((doc) => { doc.contact_paths = doc.contact_paths.slice(0, 1); }, /two distinct reachable/i);
expectFailure((doc) => { doc.load_runs = doc.load_runs.filter((run) => run.clients !== 250); }, /250-client load evidence/i);
expectFailure((doc) => { doc.load_runs[0].source_commit = 'f'.repeat(40); }, /source commit does not match/i);
expectFailure((doc) => { doc.window.ended_utc = '2026-09-20T10:59:59Z'; doc.window.duration_seconds = 3599; }, /at least 3600/i);
expectFailure((doc) => { doc.checks = doc.checks.filter((check) => check.name !== 'rooms'); }, /required check 'rooms' is missing/i);
expectFailure((doc) => { doc.checks.find((check) => check.name === 'file_a_to_b_sha256').observed_sha256 = 'bad'; }, /observed_sha256/i);
expectFailure((doc) => { doc.failover.recovered_via_peer_ids = [doc.failover.lost_peer_id]; }, /cannot use the participant/i);
expectFailure((doc) => { doc.failover.rooms_recovered = false; }, /discovery, chat and room recovery/i);
expectFailure((doc) => { doc.candidate.artifact_sha256 = 'B'.repeat(64); }, /artifact_sha256/i);

console.log('Global Beta evidence validator self-tests passed.');
