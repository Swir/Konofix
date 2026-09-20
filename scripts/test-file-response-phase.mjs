import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const checker = path.resolve('scripts/check-file-response-phase.mjs');
const canonical = fs.readFileSync('src-tauri/src/lib.rs', 'utf8').replaceAll('\r\n', '\n');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'konofix-response-phase-'));
const mutateOnce = (source, from, to) => {
  const first = source.indexOf(from);
  if (first < 0 || source.indexOf(from, first + from.length) >= 0) throw new Error(`Mutation target must exist exactly once: ${from}`);
  return source.slice(0, first) + to + source.slice(first + from.length);
};
const run = source => { const p = path.join(dir, 'lib.rs'); fs.writeFileSync(p, source); return spawnSync(process.execPath, [checker, p], { encoding: 'utf8' }); };
if (run(canonical).status !== 0) throw new Error('Canonical response-phase policy failed.');
const cases = [
  ['guard disabled', 'if !file_response_matches_outbound_kind(meta.kind, &response) {', 'if false && !file_response_matches_outbound_kind(meta.kind, &response) {', 'Wrong-phase response guard is missing'],
  ['helper renamed', 'fn file_response_matches_outbound_kind(kind: OutboundKind, response: &FileResponse) -> bool {', 'fn disabled_file_response_matches_outbound_kind(kind: OutboundKind, response: &FileResponse) -> bool {', 'Offer response policy is missing'],
  ['pending offer acknowledgement removed from phase policy', 'FileResponse::Pending\n                | FileResponse::Accepted', 'FileResponse::Accepted', 'Offer must accept immediate Pending acknowledgement'],
  ['accept response policy removed', 'OutboundKind::Accept => matches!(', 'OutboundKind::Cancel => matches!(', 'Accept-control response policy is missing'],
  ['protocol failure removed', 'Nieoczekiwana odpowiedź P2P dla bieżącego etapu transferu.', 'ignored wrong phase', 'deterministic protocol failure'],
  ['wrong-phase accept incoming cleanup removed', 'incoming.remove(&meta.transfer_id)', 'incoming.get(&meta.transfer_id)', 'reclaim only the matching incoming transfer'],
  ['wrong-phase accept temp cleanup removed', 'tokio::fs::remove_file(&temp_path).await;', '/* temp cleanup removed */', 'remove its reserved temp file'],
  ['reject/cancel no longer terminal', 'OutboundKind::Reject | OutboundKind::Cancel => true,', 'OutboundKind::Reject | OutboundKind::Cancel => false,', 'Reject/Cancel controls must remain terminal/idempotent'],
];
for (const [name, from, to, expected] of cases) {
  const result = run(mutateOnce(canonical, from, to));
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (result.status === 0 || !output.includes(expected)) throw new Error(`Mutation '${name}' was not rejected as expected. Output:\n${output}`);
}
fs.rmSync(dir, { recursive: true, force: true });
console.log(`File response phase adversarial tests passed (${cases.length} mutations rejected).`);
