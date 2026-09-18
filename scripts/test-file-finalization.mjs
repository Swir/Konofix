import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkFileFinalizationSource } from './check-file-finalization.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(ROOT, 'src-tauri/src/incoming_file.rs'), 'utf8');

function expectPolicyFailure(mutated, pattern) {
  const errors = checkFileFinalizationSource(mutated);
  assert.ok(errors.some((error) => pattern.test(error)), `Expected ${pattern} failure, got: ${errors.join(' | ')}`);
}

assert.deepEqual(checkFileFinalizationSource(source), []);

expectPolicyFailure(
  source.replace('.create_new(true)', '.create(true)'),
  /create_new/,
);

expectPolicyFailure(
  source.replace('destination.sync_all().await', 'destination.flush().await'),
  /sync_all/,
);

expectPolicyFailure(
  source.replace('fs::hard_link(temp_path, final_path).await', 'fs::rename(temp_path, final_path).await'),
  /hard-link|rename/i,
);

expectPolicyFailure(
  source.replace('let _ = fs::remove_file(final_path).await;', 'let _ = fs::metadata(final_path).await;'),
  /partial final output/,
);

expectPolicyFailure(
  source.replace('copy_fallback_never_overwrites_racing_destination', 'copy_fallback_race_test_removed'),
  /racing destination/,
);

console.log('File finalization adversarial policy tests: PASS');
