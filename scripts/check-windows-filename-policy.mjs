import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_PATH = 'src-tauri/src/incoming_file.rs';

const REQUIRED_ASCII_DEVICES = [
  'CON', 'PRN', 'AUX', 'NUL',
  ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`),
];
const REQUIRED_SUPERSCRIPT_DEVICES = ['COM¹', 'COM²', 'COM³', 'LPT¹', 'LPT²', 'LPT³'];

export function checkWindowsFilenamePolicySource(source) {
  const errors = [];
  const detectorStart = source.indexOf('fn is_windows_reserved_device_basename(');
  const neutralizerStart = source.indexOf('fn neutralize_windows_reserved_device_name(');
  const boundedStart = source.indexOf('fn bounded_safe_filename(');
  const candidateStart = source.indexOf('\nfn candidate_path(', boundedStart);

  if (detectorStart < 0 || neutralizerStart < 0 || boundedStart < 0 || candidateStart < 0) {
    return ['Could not isolate Windows reserved-name hardening; filename policy cannot be verified.'];
  }

  const detector = source.slice(detectorStart, neutralizerStart);
  const neutralizer = source.slice(neutralizerStart, boundedStart);
  const bounded = source.slice(boundedStart, candidateStart);

  if (!detector.includes('to_ascii_uppercase()')) {
    errors.push('Windows reserved device aliases must be matched case-insensitively for ASCII letters.');
  }
  for (const device of [...REQUIRED_ASCII_DEVICES, ...REQUIRED_SUPERSCRIPT_DEVICES]) {
    if (!detector.includes(`"${device}"`)) {
      errors.push(`Windows reserved device alias ${device} is missing from the receive-side guard.`);
    }
  }

  if (!neutralizer.includes(".split_once('.')")) {
    errors.push('Windows device detection must inspect the basename before the first dot so multi-dot reserved names stay blocked.');
  }
  if (!neutralizer.includes('format!("_{name}")')) {
    errors.push('Reserved device basenames must be neutralized without dropping the original filename payload.');
  }
  if (!bounded.includes('neutralize_windows_reserved_device_name(safe_filename(raw))')) {
    errors.push('Reserved-device neutralization must run before the encoded-byte reservation bound is applied.');
  }
  if (!bounded.includes('MAX_SAFE_FILENAME_BYTES')) {
    errors.push('Windows reserved-name hardening must preserve the established encoded UTF-8 component bound.');
  }

  const requiredTests = [
    'windows_reserved_multidot_names_are_neutralized_before_reservation',
    'windows_superscript_com_lpt_aliases_are_neutralized',
    'existing_ascii_device_guard_is_not_double_prefixed',
    'reserved_device_hardening_preserves_utf8_byte_budget',
  ];
  for (const testName of requiredTests) {
    if (!source.includes(testName)) {
      errors.push(`Missing Windows filename regression test: ${testName}.`);
    }
  }

  return errors;
}

function main() {
  const source = fs.readFileSync(path.join(ROOT, SOURCE_PATH), 'utf8');
  const errors = checkWindowsFilenamePolicySource(source);
  if (errors.length > 0) {
    for (const error of errors) console.error(`WINDOWS FILENAME POLICY ERROR: ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log('Windows reserved filename policy: PASS');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
