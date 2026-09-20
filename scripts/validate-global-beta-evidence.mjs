import crypto from 'node:crypto';
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
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_LOAD_EVIDENCE_BYTES = 32 * 1024 * 1024;
const MAX_CANDIDATE_ARTIFACT_BYTES = 4 * 1024 * 1024 * 1024;
const MIN_LOAD_SUCCESS_PERCENT = 95;

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

function ensureFiniteInteger(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) fail(`${label} must be an integer >= ${minimum}.`);
  return value;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function resolveEvidencePath(root, raw, label) {
  const value = nonEmpty(raw, label);
  if (path.isAbsolute(value)) fail(`${label} must be relative to the evidence manifest directory.`);
  const lexical = path.resolve(root, value);
  if (!isInside(root, lexical)) fail(`${label} escapes the evidence manifest directory.`);
  if (!fs.existsSync(lexical)) fail(`${label} does not exist: ${value}`);
  const realRoot = fs.realpathSync(root);
  const realTarget = fs.realpathSync(lexical);
  if (!isInside(realRoot, realTarget)) fail(`${label} resolves outside the evidence manifest directory.`);
  return realTarget;
}

function readExactFile(filePath, maxBytes, label) {
  const descriptor = fs.openSync(filePath, 'r');
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) fail(`${label} must be a regular file.`);
    if (stat.size <= 0) fail(`${label} must not be empty.`);
    if (stat.size > maxBytes) fail(`${label} exceeds the ${maxBytes}-byte safety limit.`);
    if (stat.size > Number.MAX_SAFE_INTEGER) fail(`${label} is too large to validate safely.`);

    const bytes = Buffer.alloc(Number(stat.size));
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (read <= 0) fail(`${label} ended before the captured byte count was read.`);
      offset += read;
    }
    const after = fs.fstatSync(descriptor);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) {
      fail(`${label} changed while it was being captured.`);
    }
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function parseJsonBytes(bytes, label) {
  let document;
  try {
    document = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    fail(`${label} is not valid UTF-8 JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return document;
}

function validateLoadArtifact(load, expectedClients, version, sourceCommit, label) {
  if (!load || typeof load !== 'object' || Array.isArray(load)) fail(`${label} root must be an object.`);
  if (load.schema !== 2) fail(`${label}.schema must equal 2.`);
  if (load.tool !== 'konofix-global-beta-load') fail(`${label}.tool must equal konofix-global-beta-load.`);
  if (load.status !== 'pass') fail(`${label}.status must equal pass.`);
  if (load.clients !== expectedClients) fail(`${label}.clients must equal ${expectedClients}.`);

  const threshold = Number(load.minimum_success_percent);
  const observed = Number(load.success_percent);
  if (!Number.isFinite(threshold) || threshold < MIN_LOAD_SUCCESS_PERCENT || threshold > 100) {
    fail(`${label}.minimum_success_percent must be between ${MIN_LOAD_SUCCESS_PERCENT} and 100.`);
  }
  if (!Number.isFinite(observed) || observed < threshold || observed > 100) {
    fail(`${label}.success_percent must satisfy its declared threshold.`);
  }
  ensureFiniteInteger(load.passed, `${label}.passed`, 0);
  ensureFiniteInteger(load.failed, `${label}.failed`, 0);
  if (load.passed + load.failed !== expectedClients) fail(`${label} passed+failed must equal clients.`);

  const exactBuild = load.exact_build;
  if (!exactBuild || typeof exactBuild !== 'object') fail(`${label}.exact_build is required.`);
  if (exactBuild.version !== version) fail(`${label}.exact_build.version does not match the candidate.`);
  if (exactBuild.source_commit !== sourceCommit) fail(`${label}.exact_build.source_commit does not match the candidate.`);
  if (!SHA256_RE.test(String(exactBuild.netprobe_sha256 ?? ''))) fail(`${label}.exact_build.netprobe_sha256 is invalid.`);
  ensureFiniteInteger(exactBuild.netprobe_bytes, `${label}.exact_build.netprobe_bytes`, 1);

  const health = load.node_health;
  if (!health || health.verified !== true) fail(`${label}.node_health.verified must be true.`);
  if (health.version !== version) fail(`${label}.node_health.version does not match the candidate.`);
  if (health.source_commit !== sourceCommit) fail(`${label}.node_health.source_commit does not match the candidate.`);
  nonEmpty(health.peer_id, `${label}.node_health.peer_id`);
  ensureFiniteInteger(health.pre_timestamp_unix, `${label}.node_health.pre_timestamp_unix`, 1);
  ensureFiniteInteger(health.post_timestamp_unix, `${label}.node_health.post_timestamp_unix`, 1);
  ensureFiniteInteger(health.pre_uptime_seconds, `${label}.node_health.pre_uptime_seconds`, 0);
  ensureFiniteInteger(health.post_uptime_seconds, `${label}.node_health.post_uptime_seconds`, 0);
  if (health.post_timestamp_unix <= health.pre_timestamp_unix) fail(`${label} Node health timestamp must advance.`);
  if (health.post_uptime_seconds < health.pre_uptime_seconds) fail(`${label} Node uptime must not move backwards.`);

  const tcp = load.tcp;
  const quic = load.quic;
  if (!tcp || !quic) fail(`${label} must contain TCP and QUIC-v1 summaries.`);
  ensureFiniteInteger(tcp.attempted, `${label}.tcp.attempted`, 1);
  ensureFiniteInteger(tcp.passed, `${label}.tcp.passed`, 1);
  ensureFiniteInteger(quic.attempted, `${label}.quic.attempted`, 1);
  ensureFiniteInteger(quic.passed, `${label}.quic.passed`, 1);
  if (tcp.passed > tcp.attempted || quic.passed > quic.attempted) fail(`${label} transport passed counts cannot exceed attempted counts.`);
}

export function validateGlobalBetaEvidence(document, options = {}) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) fail('root must be an object.');
  if (document._template === true) fail('template manifests can never qualify as PASS evidence.');
  if (document.schema !== 1) fail('schema must equal 1.');
  if (document.tool !== 'konofix-global-beta-evidence') fail("tool must equal 'konofix-global-beta-evidence'.");
  if (document.status !== 'pass') fail('status must equal pass.');

  const candidate = document.candidate;
  if (!candidate || typeof candidate !== 'object') fail('candidate is required.');
  const version = nonEmpty(candidate.version, 'candidate.version');
  const sourceCommit = nonEmpty(candidate.source_commit, 'candidate.source_commit');
  const artifactPath = nonEmpty(candidate.artifact_path, 'candidate.artifact_path');
  if (!COMMIT_RE.test(sourceCommit)) fail('candidate.source_commit must be a canonical lowercase 40-character Git SHA.');
  if (!SHA256_RE.test(String(candidate.artifact_sha256 ?? ''))) {
    fail('candidate.artifact_sha256 must be a lowercase 64-character SHA-256 digest.');
  }
  if (path.isAbsolute(artifactPath)) fail('candidate.artifact_path must be relative to the evidence manifest directory.');
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
    if (!SHA256_RE.test(String(run.sha256 ?? ''))) fail(`${count}-client load evidence sha256 is invalid.`);
    const runPath = nonEmpty(run.path, `load_runs[${index}].path`);
    if (path.isAbsolute(runPath)) fail(`load_runs[${index}].path must be relative to the evidence manifest directory.`);
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
    artifact_path: artifactPath,
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

export function validateGlobalBetaEvidencePackage(document, manifestDirectory, options = {}) {
  const summary = validateGlobalBetaEvidence(document, options);
  const root = fs.realpathSync(manifestDirectory);

  const artifactPath = resolveEvidencePath(root, document.candidate.artifact_path, 'candidate.artifact_path');
  const artifactBytes = readExactFile(artifactPath, MAX_CANDIDATE_ARTIFACT_BYTES, 'candidate artifact');
  const artifactSha256 = sha256(artifactBytes);
  if (artifactSha256 !== document.candidate.artifact_sha256) {
    fail(`candidate artifact SHA-256 mismatch (expected=${document.candidate.artifact_sha256}, actual=${artifactSha256}).`);
  }

  const loadRuns = new Map(document.load_runs.map((run) => [Number(run.clients), run]));
  const verifiedLoads = [];
  for (const clients of REQUIRED_LOAD_CLIENTS) {
    const run = loadRuns.get(clients);
    const label = `${clients}-client load evidence`;
    const loadPath = resolveEvidencePath(root, run.path, `${label}.path`);
    const bytes = readExactFile(loadPath, MAX_LOAD_EVIDENCE_BYTES, label);
    const observedSha = sha256(bytes);
    if (observedSha !== run.sha256) {
      fail(`${label} SHA-256 mismatch (expected=${run.sha256}, actual=${observedSha}).`);
    }
    const load = parseJsonBytes(bytes, label);
    validateLoadArtifact(load, clients, summary.version, summary.source_commit, label);
    verifiedLoads.push({ clients, path: run.path, sha256: observedSha });
  }

  return {
    ...summary,
    artifact_sha256: artifactSha256,
    load_artifacts: verifiedLoads,
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
  return { evidencePath: path.resolve(evidencePath), options };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { evidencePath, options } = parseCli(process.argv.slice(2));
    const manifestRoot = path.dirname(evidencePath);
    const manifestBytes = readExactFile(evidencePath, MAX_MANIFEST_BYTES, 'Global Beta evidence manifest');
    const document = parseJsonBytes(manifestBytes, 'Global Beta evidence manifest');
    const summary = validateGlobalBetaEvidencePackage(document, manifestRoot, options);
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
