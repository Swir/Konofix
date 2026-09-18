from pathlib import Path
import json


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


lib_path = Path("src-tauri/src/lib.rs")
lib = lib_path.read_text(encoding="utf-8")

lib = replace_once(
    lib,
    "const NICK_LEASE_SECS: u64 = 42;\n",
    "const NICK_LEASE_SECS: u64 = 42;\nconst NICK_LEASE_CLOCK_SKEW_SECS: u64 = 5;\n",
    "nickname lease skew constant",
)

helper = '''fn nick_lease_hint_is_well_formed(lease: &NickLease, record_key: &RecordKey, now: u128) -> bool {
    let Ok(peer) = lease.peer_id.parse::<PeerId>() else {
        return false;
    };
    if peer.to_string() != lease.peer_id {
        return false;
    }
    let Ok(valid_nick) = validate_nick(&lease.nick) else {
        return false;
    };
    let expected_canonical = canonical_nick(&valid_nick);
    if lease.canonical != expected_canonical {
        return false;
    }
    let expected_key = nick_record_key(&expected_canonical);
    if record_key != &expected_key {
        return false;
    }
    let max_expires = now.saturating_add(
        (NICK_LEASE_SECS.saturating_add(NICK_LEASE_CLOCK_SKEW_SECS) as u128).saturating_mul(1000),
    );
    lease.expires_at > now && lease.expires_at <= max_expires
}

'''
lib = replace_once(
    lib,
    "fn check_nick_conflict(\n",
    helper + "fn check_nick_conflict(\n",
    "nickname hint validator insertion",
)

old_dht = '''                        kad::QueryResult::GetRecord(Ok(GetRecordOk::FoundRecord(peer_record))) => {
                            if let Ok(lease) = serde_json::from_slice::<NickLease>(&peer_record.record.value) {
                                if check_nick_conflict(&lease.peer_id, &lease.canonical, lease.expires_at, local_peer, &canonical) {
                                    let _ = app.emit("nick-conflict", serde_json::json!({"nick": nick, "peer_id": lease.peer_id}));
                                    break 'network;
                                }
                            }
                        }
'''
new_dht = '''                        kad::QueryResult::GetRecord(Ok(GetRecordOk::FoundRecord(peer_record))) => {
                            if let Ok(lease) = serde_json::from_slice::<NickLease>(&peer_record.record.value) {
                                // Kademlia metadata and payload Peer IDs are not cryptographic proof of
                                // application-level nickname ownership. Unsigned DHT leases are hints only.
                                if !nick_lease_hint_is_well_formed(&lease, &peer_record.record.key, now_ms()) {
                                    let _ = app.emit(
                                        "network-warning",
                                        "Dropped malformed or unbounded DHT nickname hint.",
                                    );
                                }
                            }
                        }
'''
lib = replace_once(lib, old_dht, new_dht, "DHT nickname authority removal")

tests = '''#[cfg(test)]
mod nickname_lease_hint_tests {
    use super::*;

    fn test_peer() -> PeerId {
        libp2p::identity::Keypair::generate_ed25519()
            .public()
            .to_peer_id()
    }

    fn lease(peer: PeerId, nick: &str, expires_at: u128) -> NickLease {
        NickLease {
            peer_id: peer.to_string(),
            nick: nick.to_string(),
            canonical: canonical_nick(nick),
            expires_at,
        }
    }

    #[test]
    fn live_hint_requires_matching_key_identity_and_canonical_nick() {
        let now = 1_000_000u128;
        let lease = lease(test_peer(), "Alice", now + (NICK_LEASE_SECS as u128 * 1000));
        let key = nick_record_key(&lease.canonical);
        assert!(nick_lease_hint_is_well_formed(&lease, &key, now));

        let wrong_key = nick_record_key("mallory");
        assert!(!nick_lease_hint_is_well_formed(&lease, &wrong_key, now));

        let mut wrong_canonical = lease.clone();
        wrong_canonical.canonical = "mallory".into();
        assert!(!nick_lease_hint_is_well_formed(&wrong_canonical, &key, now));

        let mut invalid_peer = lease.clone();
        invalid_peer.peer_id = "not-a-peer-id".into();
        assert!(!nick_lease_hint_is_well_formed(&invalid_peer, &key, now));
    }

    #[test]
    fn hint_expiration_is_fail_closed_and_bounded() {
        let now = 2_000_000u128;
        let expired = lease(test_peer(), "Alice", now);
        let key = nick_record_key(&expired.canonical);
        assert!(!nick_lease_hint_is_well_formed(&expired, &key, now));

        let too_far = lease(
            test_peer(),
            "Alice",
            now + ((NICK_LEASE_SECS + NICK_LEASE_CLOCK_SKEW_SECS + 1) as u128 * 1000),
        );
        assert!(!nick_lease_hint_is_well_formed(&too_far, &key, now));
    }
}

'''
lib = replace_once(
    lib,
    "#[cfg(test)]\nmod authenticated_event_tests {\n",
    tests + "#[cfg(test)]\nmod authenticated_event_tests {\n",
    "nickname hint tests insertion",
)
lib_path.write_text(lib, encoding="utf-8")

checker = r'''import fs from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DHT_MARKER = "kad::QueryResult::GetRecord(Ok(GetRecordOk::FoundRecord(peer_record))) => {";

export function findDhtGetRecordRange(source) {
  const start = source.indexOf(DHT_MARKER);
  if (start < 0) return null;
  const open = source.indexOf("{", start + DHT_MARKER.length - 1);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return { start, end: i + 1 };
    }
  }
  return null;
}

export function checkNicknameLeaseTrust(source) {
  const errors = [];
  const range = findDhtGetRecordRange(source);
  if (!range) {
    errors.push("unable to isolate DHT GetRecord handling");
  } else {
    const dhtBlock = source.slice(range.start, range.end);
    if (!dhtBlock.includes("nick_lease_hint_is_well_formed(")) errors.push("DHT nickname records must pass the bounded hint validator");
    if (dhtBlock.includes("check_nick_conflict(")) errors.push("unsigned DHT nickname records must never invoke conflict authority");
    if (dhtBlock.includes('app.emit("nick-conflict"')) errors.push("unsigned DHT nickname records must never emit nick-conflict");
    if (dhtBlock.includes("break 'network")) errors.push("unsigned DHT nickname records must never terminate the network session");
  }
  for (const required of [
    "fn nick_lease_hint_is_well_formed(",
    "record_key != &expected_key",
    "lease.expires_at > now && lease.expires_at <= max_expires",
    "NICK_LEASE_CLOCK_SKEW_SECS",
  ]) {
    if (!source.includes(required)) errors.push(`missing nickname hint guard: ${required}`);
  }
  const gossipStart = source.indexOf("SwarmEvent::Behaviour(BehaviourEvent::Gossipsub");
  if (gossipStart < 0) {
    errors.push("unable to isolate authenticated GossipSub path");
  } else {
    const gossipBlock = source.slice(gossipStart, gossipStart + 24000);
    if (!gossipBlock.includes("wire_event_matches_source(&event, authenticated_source)")) errors.push("GossipSub payload identity must stay bound to authenticated source");
    if (!gossipBlock.includes("WireEvent::NickClaim") || !gossipBlock.includes("check_nick_conflict(")) errors.push("authenticated GossipSub NickClaim must retain deterministic conflict handling");
  }
  return errors;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const source = fs.readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  const errors = checkNicknameLeaseTrust(source);
  if (errors.length) {
    for (const error of errors) console.error(`nickname-lease-trust: ${error}`);
    process.exit(1);
  }
  console.log("nickname-lease-trust: policy verified");
}
'''
Path("scripts/check-nickname-lease-trust.mjs").write_text(checker, encoding="utf-8")

adversarial = r'''import fs from "node:fs";
import { checkNicknameLeaseTrust, findDhtGetRecordRange } from "./check-nickname-lease-trust.mjs";

const source = fs.readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
const baseline = checkNicknameLeaseTrust(source);
if (baseline.length) throw new Error(`baseline policy failed: ${baseline.join("; ")}`);

function mutateDht(input, mutate) {
  const range = findDhtGetRecordRange(input);
  if (!range) throw new Error("DHT block unavailable for mutation");
  const block = input.slice(range.start, range.end);
  const changed = mutate(block);
  if (changed === block) throw new Error("DHT mutation did not apply");
  return input.slice(0, range.start) + changed + input.slice(range.end);
}

const mutations = [
  ["remove DHT hint validation", s => mutateDht(s, b => b.replace("nick_lease_hint_is_well_formed", "accept_untrusted_nick_hint"))],
  ["restore DHT conflict authority", s => mutateDht(s, b => b.replace("if let Ok(lease)", "check_nick_conflict(&lease.peer_id, &lease.canonical, lease.expires_at, local_peer, &canonical);\n                            if let Ok(lease)"))],
  ["drop DHT key binding", s => s.replace("record_key != &expected_key", "false")],
  ["drop lease upper bound", s => s.replace("lease.expires_at > now && lease.expires_at <= max_expires", "lease.expires_at > now")],
  ["drop GossipSub source binding", s => s.replace("wire_event_matches_source(&event, authenticated_source)", "true")],
];

let rejected = 0;
for (const [name, mutate] of mutations) {
  const changed = mutate(source);
  if (changed === source) throw new Error(`${name}: mutation did not apply`);
  const errors = checkNicknameLeaseTrust(changed);
  if (!errors.length) throw new Error(`${name}: unsafe mutation was accepted`);
  rejected += 1;
}
console.log(`nickname-lease-trust adversarial: ${rejected}/${mutations.length} unsafe mutations rejected`);
'''
Path("scripts/test-nickname-lease-trust.mjs").write_text(adversarial, encoding="utf-8")

pkg_path = Path("package.json")
pkg = json.loads(pkg_path.read_text(encoding="utf-8"))
marker = "node scripts/test-network-session-lifecycle.mjs && node scripts/check-network-session-lifecycle.mjs"
insertion = "node scripts/test-nickname-lease-trust.mjs && node scripts/check-nickname-lease-trust.mjs && " + marker
audit = pkg["scripts"]["audit"]
if insertion not in audit:
    if marker not in audit:
        raise SystemExit("package audit anchor missing")
    pkg["scripts"]["audit"] = audit.replace(marker, insertion, 1)
pkg["scripts"]["audit:nickname-lease-trust"] = "node scripts/check-nickname-lease-trust.mjs"
pkg["scripts"]["test:nickname-lease-trust"] = "node scripts/test-nickname-lease-trust.mjs"
pkg_path.write_text(json.dumps(pkg, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

Path("docs/NICKNAME_SECURITY.md").write_text(
    """# Nickname trust boundary

Konofix uses two transports for nickname reservation signals, but they do not have the same authority.

## Authoritative path

GossipSub messages are signed by libp2p and the application requires the payload Peer ID to match the authenticated message source. A well-formed `NickClaim` from that path may participate in deterministic nickname conflict resolution.

## DHT path

The current JSON `NickLease` stored in Kademlia has no application-level signature. Neither the payload `peer_id` nor Kademlia `record.publisher` is proof that the claimed Peer ID created the lease, so DHT nickname records are non-authoritative hints only.

Before an unsigned hint is treated as structurally plausible, Konofix verifies Peer ID syntax, nickname validation/canonicalization, the exact DHT key, a live expiration, and an upper lifetime bound equal to the lease window plus a small clock-skew allowance. Even a valid unsigned hint cannot emit `nick-conflict`, disconnect a client, or reject its nickname.

A future signed lease may become authoritative only if its signature covers protocol/domain separation, canonical and display nickname, publisher Peer ID and expiration, and its public key proves the claimed Peer ID.

## Regression policy

`scripts/check-nickname-lease-trust.mjs` is part of `npm run audit`. Its adversarial companion verifies that removing DHT hint validation/key/lifetime checks, restoring DHT conflict authority, or removing GossipSub source binding fails closed. Rust unit tests cover the same structural boundaries.
""",
    encoding="utf-8",
)

changelog_path = Path("CHANGELOG.md")
changelog = changelog_path.read_text(encoding="utf-8")
changelog_anchor = "## 0.4.2\n\n"
changelog_entry = "- hardened distributed nickname reservation so unsigned Kademlia `NickLease` records are non-authoritative hints only: DHT payloads can no longer trigger `nick-conflict` or disconnect a client, plausible hints are bounded by Peer ID/nickname/canonical key/lifetime validation, authenticated GossipSub claims retain deterministic conflict handling, and Rust plus adversarial source-policy tests guard the trust boundary without adding Real Internet Test credit,\n"
if changelog_entry not in changelog:
    changelog = replace_once(changelog, changelog_anchor, changelog_anchor + changelog_entry, "changelog 0.4.2 anchor")
changelog_path.write_text(changelog, encoding="utf-8")

roadmap_path = Path("ROADMAP.md")
roadmap = roadmap_path.read_text(encoding="utf-8")
roadmap_anchor = "The active milestone currently has 54 of 59 tasks complete. The remaining five tasks require real public-network evidence and fixes discovered during those tests; CI alone cannot credit them.\n"
roadmap_note = "\n- Distributed nickname trust hardening now treats unsigned Kademlia nickname leases as bounded, non-authoritative hints; only source-authenticated GossipSub claims can enforce a nickname conflict. This security fix adds no Real Internet Test credit.\n"
if roadmap_note.strip() not in roadmap:
    roadmap = replace_once(roadmap, roadmap_anchor, roadmap_anchor + roadmap_note, "roadmap active milestone anchor")
roadmap_path.write_text(roadmap, encoding="utf-8")
