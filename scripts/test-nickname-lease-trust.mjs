import fs from "node:fs";
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
