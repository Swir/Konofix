import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const checker = path.join(root, 'scripts', 'check-readme-standard.mjs');
const canonical = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'konofix-readme-policy-'));

const runChecker = (name, content, expectedSuccess) => {
  const fixture = path.join(tempRoot, `${name}.md`);
  fs.writeFileSync(fixture, content, 'utf8');
  const result = spawnSync(process.execPath, [checker, fixture], {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
  });
  const succeeded = result.status === 0;
  if (succeeded !== expectedSuccess) {
    throw new Error(
      `${name}: expected checker success=${expectedSuccess}, exit=${result.status}\nstdout=${result.stdout}\nstderr=${result.stderr}`,
    );
  }
  console.log(`PASS: ${name} -> ${expectedSuccess ? 'accepted' : 'rejected'}`);
};

try {
  runChecker('canonical', canonical, true);
  runChecker('windows-crlf', canonical.replace(/\r?\n/g, '\r\n'), true);
  runChecker('missing-marker', canonical.replace('<!-- SWIR-README-STANDARD:v1 -->', '<!-- missing-standard -->'), false);
  runChecker('missing-icon', canonical.replace('./src-tauri/icons/icon.ico', './missing-icon.png'), false);
  runChecker('false-completion', canonical.replace('Real Internet Test milestone: 92% complete', 'Real Internet Test milestone: 100% complete'), false);
  runChecker('missing-prerelease-truth', canonical.replaceAll('v0.4.2-test1', 'v0.4.2'), false);

  const keywordsHeading = '## 🔎 Search Keywords';
  const keywordStart = canonical.indexOf(keywordsHeading);
  const afterHeading = canonical.slice(keywordStart + keywordsHeading.length);
  const dividerOffset = afterHeading.search(/\r?\n<img\b/i);
  if (keywordStart < 0 || dividerOffset < 0) {
    throw new Error('Canonical README keyword section could not be located for fixture mutation.');
  }
  const keywordEnd = keywordStart + keywordsHeading.length + dividerOffset;
  const tooFewKeywords = `${canonical.slice(0, keywordStart)}${keywordsHeading}\n\n\`peer to peer messenger\`\n${canonical.slice(keywordEnd)}`;
  runChecker('too-few-keywords', tooFewKeywords, false);

  const duplicateKeyword = canonical.replace(
    '`cg-nat p2p testing`',
    '`peer to peer messenger`',
  );
  runChecker('duplicate-keywords', duplicateKeyword, false);

  console.log('SWIR README policy adversarial self-tests passed.');
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
