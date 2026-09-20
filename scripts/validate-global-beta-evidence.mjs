import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SHA256_RE = /^[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const COUNTRY_RE = /^[A-Z]{2}$/;
const PEER_RE = /^[1-9A-HJ-NP-Za-km-z]{20,}$/;
const REQUIRED_LOAD_CLIENTS = [50, 100, 250];
const REQUIRED_CHECKS = [
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
];

function fail(message) {
  throw new Error(`Global Beta evidence invalid: ${message}`);
}

function nonEmpty(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) fail(`${label} must be non-empty.`);
  return value.trim();
}

function unique(values) {
  return new Set(values).size;
}

function validDate(value, label) {
  const raw = nonEmpty(value, label);
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) fail(`${label} must be an ISO-8601 timestamp.`);
  return timestamp;
}

function requirePassCheck(checksByName, name) {
  const check = checksByName.get(name);
  if (!check) fail(`required check '${name}' is missing.`);
  if (check.status !== 'pass') fail(`required check '${name}' must have status=pass.`);
  nonEmpty(check.evidence, `checks.${name}.evidence`);
  if (name.includes('sha256')) {
    if (!SHA256_RE.test(String(check.observed_sha256 ?? ''))) {
      fail(`checks.${name}.observed_sha256 must be a lowercase 64-character SHA-256 digest.`);
    }
  }
}

export function validateGlobalBetaEvidence(document, options = {}) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) fail('root must be an object.');
  if (document.schema !== 1) fail('schema must equal 1.');
  if (document.tool !== 'konofix-global-beta-evidence') fail("tool must equal 'konofix-global-beta-evidence'.");
  if (document.status !== 'pass') fail('status must equal pass.');

  const candidate = document.candidate;
  if (!candidate || typeof candidate !== 'object') fail('candidate is required.');
  const version = nonEmpty(candidate.version, 'candidate.version');
  const sourceCommit = nonEmpty(candidate.source_commit, 'candidate.source_commit');
  if (!COMMIT_RE.test(sourceCommit)) fail('candidate.source_commit must be a canonical lowercase 40-character Git SHA.');
  if (!SHA256_RE.test(String(candidate.artifact_sha256 ?? ''))) {
    fail('candidate.artifact_sha256 must be a lowercase 64-character SHA-256 digest.');
  }
  if (options.expectedVersion && version !== options.expectedVersion) {
    fail(`candidate.version mismatch (expected=${options.expectedVersion}, actual=${version}).`);
  }
  if (options.expectedCommit && sourceCommit !== options.expectedCommit) {
    fail(`candidate.source_commit mismatch (expected=${options.expectedCommit}, actual=${sourceCommit}).`);
  }

  const window = document.window;
  if (!window || typeof window !== 'object') fail('window is required.');
  const started = validDate(window.started_utc, 'window.started_utc');
  const ended = validDate(window.ended_utc, 'window.ended_utc');
  if (ended <= started) fail('window.ended_utc must be after window.started_utc.');
  const durationSeconds = Number(window.duration_seconds);
  if (!Number.isFinite(durationSeconds) || durationSeconds < 3600) fail('window.duration_seconds must be at least 3600.');
  const observedDuration = (ended - started) / 1000;
  if (observedDuration < 3600) fail('timestamp window must span at least 60 minutes.');
  if (Math.abs(observedDuration - durationSeconds) > 5) {
    fail('window.duration_seconds must match the timestamp span within five seconds.');
  }

  const participants = Array.isArray(document.participants) ? document.participants : [];
  if (participants.length < 3) fail('at least three participant nodes are required.');
  const participantPeers = [];
  const participantNetworks = [];
  for (const [index, participant] of participants.entries()) {
    const prefix = `participants[${index}]`;
    const peer = nonEmpty(participant?.peer_id, `${prefix}.peer_id`);
    if (!PEER_RE.test(peer)) fail(`${prefix}.peer_id does not look like a canonical Peer ID.`);
    participantPeers.push(peer);
    participantNetworks.push(nonEmpty(participant?.network_id, `${prefix}.network_id`));
    const country = nonEmpty(participant?.country, `${prefix}.country`);
    if (!COUNTRY_RE.test(country)) fail(`${prefix}.country must be a two-letter uppercase country code.`);
  }
  if (unique(participantPeers) !== participantPeers.length) fail('participant Peer IDs must be unique.');
  if (unique(participantNetworks) < 2) fail('participant nodes must span at least two independent network IDs.');

  const contactPaths = Array.isArray(document.contact_paths) ? document.contact_paths : [];
  const reachableContacts = contactPaths.filter((entry) => entry?.reachable === true);
  const reachablePeerIds = [];
  for (const [index, entry] of reachableContacts.entries()) {
    const prefix = `contact_paths[${index}]`;
    const peer = nonEmpty(entry.peer_id, `${prefix}.peer_id`);
    if (!participantPeers.includes(peer)) fail(`${prefix}.peer_id must belong to a participant node.`);
    reachablePeerIds.push(peer);
    const transport = nonEmpty(entry.transport, `${prefix}.transport`);
    if (!['tcp', 'quic-v1', 'relay', 'dcutr'].includes(transport)) fail(`${prefix}.transport is unsupported.`);
    nonEmpty(entry.address, `${prefix}.address`);
    nonEmpty(entry.network_id, `${prefix}.network_id`);
  }
  if (unique(reachablePeerIds) < 2) fail('at least two distinct reachable participant contact/relay identities are required.');

  const clients = Array.isArray(document.clients) ? document.clients : [];
  if (clients.length < 20) fail('at least twenty real clients are required.');
  const clientIds = [];
  const clientNetworks = [];
  const clientCountries = [];
  for (const [index, client] of clients.entries()) {
    const prefix = `clients[${index}]`;
    clientIds.push(nonEmpty(client?.id, `${prefix}.id`));
    clientNetworks.push(nonEmpty(client?.network_id, `${prefix}.network_id`));
    const country = nonEmpty(client?.country, `${prefix}.country`);
    if (!COUNTRY_RE.test(country)) fail(`${prefix}.country must be a two-letter uppercase country code.`);
    clientCountries.push(country);
  }
  if (unique(clientIds) !== clientIds.length) fail('client IDs must be unique.');
  if (unique(clientNetworks) < 5) fail('clients must span at least five independent network IDs.');
  if (unique(clientCountries) < 3) fail('clients must span at least three countries.');

  const loadRuns = Array.isArray(document.load_runs) ? document.load_runs : [];
  const loadByCount = new Map();
  for (const [index, run] of loadRuns.entries()) {
    const count = Number(run?.clients);
    if (!REQUIRED_LOAD_CLIENTS.includes(count)) continue;
    if (loadByCount.has(count)) fail(`duplicate ${count}-client load evidence is not allowed.`);
    if (run.status !== 'pass') fail(`${count}-client load evidence must have status=pass.`);
    if (run.node_health_verified !== true) fail(`${count}-client load evidence must verify stable Node health.`);
    if (run.version !== version) fail(`${count}-client load evidence version does not match the candidate.`);
    if (run.source_commit !== sourceCommit) fail(`${count}-client load evidence source commit does not match the candidate.`);
    if (!SHA256_RE.test(String(run.sha256 ?? ''))) fail(`${count}-client load evidence sha256 is invalid.`);
    nonEmpty(run.path, `load_runs[${index}].path`);
    loadByCount.set(count, run);
  }
  for (const count of REQUIRED_LOAD_CLIENTS) {
    if (!loadByCount.has(count)) fail(`missing required ${count}-client load evidence.`);
  }

  const checks = Array.isArray(document.checks) ? document.checks : [];
  const checksByName = new Map();
  for (const check of checks) {
    const name = nonEmpty(check?.name, 'checks[].name');
    if (checksByName.has(name)) fail(`duplicate check '${name}' is not allowed.`);
    checksByName.set(name, check);
  }
  for (const name of REQUIRED_CHECKS) requirePassCheck(checksByName, name);

  const failover = document.failover;
  if (!failover || typeof failover !== 'object') fail('failover evidence is required.');
  const lostPeer = nonEmpty(failover.lost_peer_id, 'failover.lost_peer_id');
  if (!participantPeers.includes(lostPeer)) fail('failover.lost_peer_id must be one of the participant nodes.');
  const recoveredVia = Array.isArray(failover.recovered_via_peer_ids) ? failover.recovered_via_peer_ids : [];
  if (recoveredVia.length === 0) fail('failover.recovered_via_peer_ids must contain at least one surviving participant.');
  for (const peer of recoveredVia) {
    if (!participantPeers.includes(peer)) fail('failover recovery identity must belong to a participant node.');
    if (peer === lostPeer) fail('failover recovery cannot use the participant that was intentionally removed.');
    if (!reachablePeerIds.includes(peer)) fail('failover recovery identity must be one of the recorded reachable contact/relay identities.');
  }
  if (failover.discovery_recovered !== true || failover.chat_recovered !== true || failover.rooms_recovered !== true) {
    fail('failover must prove discovery, chat and room recovery.');
  }
  nonEmpty(failover.evidence, 'failover.evidence');

  return {
    schema: 1,
    status: 'pass',
    version,
    source_commit: sourceCommit,
    participant_nodes: participants.length,
    participant_networks: unique(participantNetworks),
    reachable_contact_identities: unique(reachablePeerIds),
    clients: clients.length,
    client_networks: unique(clientNetworks),
    countries: unique(clientCountries),
    duration_seconds: durationSeconds,
    load_clients: REQUIRED_LOAD_CLIENTS,
    required_checks: REQUIRED_CHECKS.length,
  };
}

function parseCli(argv) {
  const args = [...argv];
  const evidencePath = args.shift();
  if (!evidencePath) fail('usage: node scripts/validate-global-beta-evidence.mjs <evidence.json> [--expected-version X] [--expected-commit SHA].');
  const options = {};
  while (args.length > 0) {
    const flag = args.shift();
    const value = args.shift();
    if (!value) fail(`${flag} requires a value.`);
    if (flag === '--expected-version') options.expectedVersion = value;
    else if (flag === '--expected-commit') options.expectedCommit = value;
    else fail(`unknown option '${flag}'.`);
  }
  return { evidencePath, options };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { evidencePath, options } = parseCli(process.argv.slice(2));
    const raw = fs.readFileSync(path.resolve(evidencePath), 'utf8');
    const document = JSON.parse(raw);
    const summary = validateGlobalBetaEvidence(document, options);
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
