import fs from 'node:fs';

const configPath = '.github/dependabot.yml';
// GitHub's Windows checkout may materialize text files with CRLF while Linux uses LF.
// Normalize before structural checks so the policy gate is semantic, not line-ending dependent.
const text = fs.readFileSync(configPath, 'utf8').replaceAll('\r\n', '\n');
const blocks = text.split(/\n(?=  - package-ecosystem:)/);

const fail = (message) => {
  console.error(`DEPENDABOT CONFIG ERROR: ${message}`);
  process.exitCode = 1;
};

const ecosystemBlocks = (ecosystem) =>
  blocks.filter((block) => new RegExp(`package-ecosystem:\\s*["']${ecosystem}["']`).test(block));

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const dependencyNames = (path) => {
  const source = fs.readFileSync(path, 'utf8');
  const names = new Set();
  let dependencySection = false;

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    const section = line.match(/^\[(.+)]$/);
    if (section) {
      dependencySection = /(?:^|\.)build-dependencies$|(?:^|\.)dependencies$/.test(section[1]);
      continue;
    }
    if (!dependencySection || !line || line.startsWith('#')) continue;
    const entry = line.match(/^([A-Za-z0-9_-]+)\s*=/);
    if (entry) names.add(entry[1]);
  }
  return names;
};

const cargoBlocks = ecosystemBlocks('cargo');
if (cargoBlocks.length !== 1) {
  fail(`expected exactly one Cargo update block, found ${cargoBlocks.length}.`);
} else {
  const cargo = cargoBlocks[0];
  if (!/^\s*directories:\s*$/m.test(cargo)) {
    fail('Cargo updates must use one multi-directory configuration for the mirrored manifests.');
  }

  const requiredDirectories = ['/src-tauri', '/node-linux'];
  for (const directory of requiredDirectories) {
    const escaped = escapeRegex(directory);
    const entry = new RegExp(`^\\s*-\\s*["']?${escaped}["']?\\s*$`, 'm');
    if (!entry.test(cargo)) {
      fail(`Cargo Dependabot coverage is missing ${directory}.`);
    }
  }

  if (/^\s*directory:\s*["']?\/src-tauri["']?\s*$/m.test(cargo)) {
    fail('Cargo Dependabot regressed to single-directory /src-tauri coverage.');
  }

  const desktop = dependencyNames('src-tauri/Cargo.toml');
  const headless = dependencyNames('node-linux/Cargo.toml');
  const onlyDesktop = [...desktop].filter((name) => !headless.has(name)).sort();
  const onlyHeadless = [...headless].filter((name) => !desktop.has(name)).sort();
  if (onlyDesktop.length || onlyHeadless.length) {
    fail(`mirrored Cargo dependency sets drifted (desktop-only=${onlyDesktop.join(',') || 'none'}; headless-only=${onlyHeadless.join(',') || 'none'}).`);
  }

  const expectedMajorGroups = new Set();
  for (const dependency of [...desktop].sort()) {
    const groupName = `${dependency.replaceAll('_', '-')}-major`;
    expectedMajorGroups.add(groupName);
    const snippet = [
      `      ${groupName}:`,
      '        patterns:',
      `          - "${dependency}"`,
      '        update-types:',
      '          - "major"',
    ].join('\n');
    if (!cargo.includes(snippet)) {
      fail(`Cargo major upgrade for '${dependency}' must have its own dependency-specific group so both manifests move together.`);
    }
  }

  const configuredMajorGroups = new Set(
    [...cargo.matchAll(/^ {6}([A-Za-z0-9_-]+-major): *$/gm)].map((match) => match[1]),
  );
  for (const group of configuredMajorGroups) {
    if (!expectedMajorGroups.has(group)) {
      fail(`unexpected Cargo major group '${group}'; major groups must map one-to-one to mirrored dependencies.`);
    }
  }
  for (const group of expectedMajorGroups) {
    if (!configuredMajorGroups.has(group)) {
      fail(`missing Cargo major group '${group}'.`);
    }
  }
}

for (const ecosystem of ['npm', 'github-actions']) {
  const matching = ecosystemBlocks(ecosystem);
  if (matching.length !== 1) {
    fail(`expected exactly one ${ecosystem} update block, found ${matching.length}.`);
    continue;
  }
  if (/^\s*-\s*["']?major["']?\s*$/m.test(matching[0])) {
    fail(`${ecosystem} major upgrades must stay ungrouped so each breaking change has an isolated review and CI cycle.`);
  }
}

if (!process.exitCode) {
  console.log('Dependabot policy: mirrored Cargo manifests move together, shared Cargo majors are dependency-isolated, and npm/Action majors remain ungrouped.');
}
