import fs from 'node:fs';

const README_PATH = process.argv[2] || 'README.md';
const STANDARD_MARKER = '<!-- SWIR-README-STANDARD:v2 -->';
const HERO_PATH = 'assets/readme/hero.svg';
const readme = fs.readFileSync(README_PATH, 'utf8');

const fail = (message) => {
  console.error(`README STANDARD ERROR: ${message}`);
  process.exitCode = 1;
};

const markerPattern = /^\uFEFF?<!-- SWIR-README-STANDARD:v2 -->\r?\n/;
if (!markerPattern.test(readme)) {
  fail(`${README_PATH} must start with ${STANDARD_MARKER}.`);
}

const requiredFragments = [
  '<div align="center">',
  `<img width="100%" src="${HERO_PATH}"`,
  'https://raw.githubusercontent.com/Swir/Swir/main/assets/power-divider-v4.svg',
  '## Project status',
  '## Highlights',
  '## Quick Start',
  '## Architecture',
  '## Security and trust boundaries',
  '## Roadmap',
  '## Releases',
  '## 🔎 Search Keywords',
  '[**← SWIR profile**](https://github.com/Swir)',
  '[**All projects →**](https://github.com/Swir?tab=repositories)',
];

for (const fragment of requiredFragments) {
  if (!readme.includes(fragment)) {
    fail(`${README_PATH} is missing required SWIR README fragment: ${fragment}`);
  }
}

if (!fs.existsSync(HERO_PATH)) {
  fail(`Canonical SWIR README PRO v2 hero asset is missing: ${HERO_PATH}.`);
}

const searchHeading = '## 🔎 Search Keywords';
const searchStart = readme.indexOf(searchHeading);
if (searchStart >= 0) {
  const afterHeading = readme.slice(searchStart + searchHeading.length);
  const boundaries = [afterHeading.search(/\r?\n##\s/), afterHeading.search(/\r?\n<img\b/i)]
    .filter((offset) => offset >= 0);
  const searchEnd = boundaries.length > 0 ? Math.min(...boundaries) : afterHeading.length;
  const searchSection = afterHeading.slice(0, searchEnd);
  const keywords = [...searchSection.matchAll(/`([^`]+)`/g)]
    .map((match) => match[1].trim())
    .filter(Boolean);
  const uniqueKeywords = new Set(keywords.map((keyword) => keyword.toLocaleLowerCase('en-US')));

  if (keywords.length < 8 || keywords.length > 20) {
    fail(`Search Keywords must contain 8-20 backtick-delimited phrases; found ${keywords.length}.`);
  }
  if (uniqueKeywords.size !== keywords.length) {
    fail('Search Keywords contains duplicate phrases.');
  }
  for (const keyword of keywords) {
    if (keyword.length < 4 || keyword.length > 60) {
      fail(`Search keyword has an unreasonable length: ${keyword}`);
    }
  }
}

const heroEnd = readme.indexOf('</div>');
if (heroEnd < 0 || heroEnd > 3500) {
  fail(`${README_PATH} must have a compact centered hero near the top.`);
}

const heroBlock = readme.slice(0, heroEnd);
const primaryBadgeCount = (heroBlock.match(/style=for-the-badge/g) || []).length;
if (primaryBadgeCount < 3 || primaryBadgeCount > 5) {
  fail(`Centered hero should contain 3-5 primary for-the-badge badges; found ${primaryBadgeCount}.`);
}
if (!heroBlock.includes(HERO_PATH)) {
  fail(`Centered hero must use the local ${HERO_PATH} asset.`);
}

if (!/Real Internet Test milestone: \d+% complete/.test(readme)) {
  fail(`${README_PATH} must expose the truthful active milestone percentage.`);
}
if (!/\d+ of \d+ tasks complete/.test(readme)) {
  fail(`${README_PATH} must expose the truthful active milestone task count.`);
}

if (/\b100% complete\b/i.test(readme)) {
  fail(`${README_PATH} must not claim 100% completion before the authoritative roadmap reaches it.`);
}

if (!/v0\.4\.2-test1/.test(readme) || !/prerelease/i.test(readme)) {
  fail(`${README_PATH} must identify v0.4.2-test1 as the current prerelease while it remains the public test artifact.`);
}

if (!process.exitCode) {
  console.log(`SWIR README PRO v2: ${README_PATH} passes marker, local-hero, information architecture, keyword, progress-truthfulness and footer checks.`);
}
