import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const checker = path.join(root, 'scripts', 'check-readme-standard.mjs');
const canonical = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const canonicalHero = fs.readFileSync(path.join(root, 'assets', 'readme', 'hero.svg'), 'utf8');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'konofix-readme-policy-'));

const runChecker = (name, content, expectedSuccess, heroContent = canonicalHero) => {
  const fixtureRoot = path.join(tempRoot, name);
  const fixture = path.join(fixtureRoot, 'README.md');
  fs.mkdirSync(fixtureRoot, { recursive: true });
  fs.writeFileSync(fixture, content, 'utf8');

  if (heroContent !== null) {
    const heroDir = path.join(fixtureRoot, 'assets', 'readme');
    fs.mkdirSync(heroDir, { recursive: true });
    fs.writeFileSync(path.join(heroDir, 'hero.svg'), heroContent, 'utf8');
  }

  const result = spawnSync(process.execPath, [checker, 'README.md'], {
    cwd: fixtureRoot,
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
  runChecker(
    'missing-marker',
    canonical.replace('<!-- SWIR-README-STANDARD:v2 -->', '<!-- missing-standard -->'),
    false,
  );
  runChecker(
    'stale-v1-marker',
    canonical.replace('<!-- SWIR-README-STANDARD:v2 -->', '<!-- SWIR-README-STANDARD:v1 -->'),
    false,
  );
  runChecker(
    'missing-local-hero-reference',
    canonical.replace('assets/readme/hero.svg', 'assets/readme/missing-hero.svg'),
    false,
  );
  runChecker('missing-local-hero-file', canonical, false, null);
  runChecker(
    'invalid-hero-geometry',
    canonical,
    false,
    canonicalHero.replace('width="1200"', 'width="1199"'),
  );
  runChecker(
    'missing-hero-accessibility-title',
    canonical,
    false,
    canonicalHero.replace(/\s*<title\b[^>]*>[^<]+<\/title>/i, ''),
  );
  runChecker(
    'remote-hero-resource',
    canonical,
    false,
    canonicalHero.replace('</svg>', '<image href="https://example.invalid/pixel.png" /></svg>'),
  );
  runChecker(
    'scripted-hero',
    canonical,
    false,
    canonicalHero.replace('</svg>', '<script>alert("x")</script></svg>'),
  );
  runChecker(
    'false-completion',
    canonical.replace('Real Internet Test milestone: 92% complete', 'Real Internet Test milestone: 100% complete'),
    false,
  );
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

  console.log('SWIR README PRO v2 policy adversarial self-tests passed.');
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
