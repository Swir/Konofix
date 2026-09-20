import fs from "node:fs";
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
    if (/app\.emit(?:_event)?\("nick-conflict"/.test(dhtBlock)) errors.push("unsigned DHT nickname records must never emit nick-conflict");
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
