import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_PATH = 'src-tauri/src/incoming_file.rs';

export function checkFileFinalizationSource(source) {
  const errors = [];
  const start = source.indexOf('async fn commit_reserved_file_impl(');
  const end = source.indexOf('\npub(crate) async fn commit_reserved_file(', start);

  if (start < 0 || end < 0 || end <= start) {
    return ['Could not isolate commit_reserved_file_impl; file-finalization policy cannot be verified.'];
  }

  const body = source.slice(start, end);

  if (!body.includes('fs::hard_link(temp_path, final_path).await')) {
    errors.push('Verified incoming files must keep same-directory hard-link promotion as the fast path.');
  }
  if (!body.includes('.create_new(true)')) {
    errors.push('Fallback finalization must create the destination exclusively with create_new(true).');
  }
  if (!body.includes('tokio::io::copy(&mut source, &mut destination).await?')) {
    errors.push('Fallback finalization must copy from the already verified owned temporary file.');
  }
  if (!body.includes('destination.flush().await?') || !body.includes('destination.sync_all().await')) {
    errors.push('Fallback output must be flushed and sync_all() completed before success is reported.');
  }
  if (/\bfs::rename\s*\(/.test(body) || /\bFile::create\s*\(\s*final_path/.test(body)) {
    errors.push('Fallback finalization must not use overwrite-prone rename/File::create on the final destination.');
  }

  const copyFailure = body.indexOf('if let Err(error) = copy_result');
  if (copyFailure < 0) {
    errors.push('Fallback copy failures must have an explicit cleanup path.');
  } else {
    const failureBody = body.slice(copyFailure);
    if (!failureBody.includes('fs::remove_file(final_path).await')) {
      errors.push('A failed fallback copy must remove its partial final output.');
    }
    if (!failureBody.includes('remove_owned_temp(temp_path).await')) {
      errors.push('A failed fallback copy must clean the transfer-owned temporary file.');
    }
  }

  if (!source.includes('copy_fallback_promotes_verified_payload_without_overwrite')) {
    errors.push('Missing regression test for successful exclusive-copy fallback.');
  }
  if (!source.includes('copy_fallback_never_overwrites_racing_destination')) {
    errors.push('Missing regression test proving a racing destination is never overwritten.');
  }

  return errors;
}

function main() {
  const source = fs.readFileSync(path.join(ROOT, SOURCE_PATH), 'utf8');
  const errors = checkFileFinalizationSource(source);
  if (errors.length > 0) {
    for (const error of errors) console.error(`FILE FINALIZATION POLICY ERROR: ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log('File finalization no-clobber policy: PASS');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
