import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkWindowsFilenamePolicySource } from './check-windows-filename-policy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(ROOT, 'src-tauri/src/incoming_file.rs'), 'utf8');

function mutateOnce(input, pattern, replacement, label) {
  const mutated = input.replace(pattern, replacement);
  assert.notEqual(mutated, input, `Adversarial mutation did not apply: ${label}`);
  return mutated;
}

function expectPolicyFailure(mutated, pattern) {
  const errors = checkWindowsFilenamePolicySource(mutated);
  assert.ok(errors.some((error) => pattern.test(error)), `Expected ${pattern} failure, got: ${errors.join(' | ')}`);
}

assert.deepEqual(checkWindowsFilenamePolicySource(source), []);

expectPolicyFailure(
  mutateOnce(source, '"COM¹"', '"COMX"', 'superscript COM alias'),
  /COM¹/,
);

expectPolicyFailure(
  mutateOnce(source, ".split_once('.')", ".rsplit_once('.')", 'first-dot device basename split'),
  /first dot/,
);

expectPolicyFailure(
  mutateOnce(
    source,
    'neutralize_windows_reserved_device_name(safe_filename(raw))',
    'safe_filename(raw)',
    'receive-side neutralization ordering',
  ),
  /neutralization.*before/i,
);

expectPolicyFailure(
  mutateOnce(
    source,
    'reserved_device_hardening_preserves_utf8_byte_budget',
    'reserved_device_utf8_budget_test_removed',
    'encoded-byte budget regression test',
  ),
  /utf8.*budget|regression test/i,
);

console.log('Windows filename adversarial policy tests: PASS');
