import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkFileFinalizationSource } from './check-file-finalization.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(ROOT, 'src-tauri/src/incoming_file.rs'), 'utf8');

function mutateOnce(input, pattern, replacement, label) {
  const mutated = input.replace(pattern, replacement);
  assert.notEqual(mutated, input, `Adversarial mutation did not apply: ${label}`);
  return mutated;
}

function expectPolicyFailure(mutated, pattern) {
  const errors = checkFileFinalizationSource(mutated);
  assert.ok(errors.some((error) => pattern.test(error)), `Expected ${pattern} failure, got: ${errors.join(' | ')}`);
}

assert.deepEqual(checkFileFinalizationSource(source), []);

expectPolicyFailure(
  mutateOnce(
    source,
    /(let mut destination = match OpenOptions::new\(\)\r?\n\s*\.write\(true\)\r?\n\s*)\.create_new\(true\)/,
    '$1.create(true)',
    'exclusive fallback destination creation',
  ),
  /create_new/,
);

expectPolicyFailure(
  mutateOnce(source, 'destination.sync_all().await', 'destination.flush().await', 'durable fallback sync'),
  /sync_all/,
);

expectPolicyFailure(
  mutateOnce(source, 'fs::hard_link(temp_path, final_path).await', 'fs::rename(temp_path, final_path).await', 'hard-link promotion'),
  /hard-link|rename/i,
);

expectPolicyFailure(
  mutateOnce(source, 'let _ = fs::remove_file(final_path).await;', 'let _ = fs::metadata(final_path).await;', 'partial fallback cleanup'),
  /partial final output/,
);

expectPolicyFailure(
  mutateOnce(source, 'copy_fallback_never_overwrites_racing_destination', 'copy_fallback_race_test_removed', 'destination-race regression test'),
  /racing destination/,
);

console.log('File finalization adversarial policy tests: PASS');
