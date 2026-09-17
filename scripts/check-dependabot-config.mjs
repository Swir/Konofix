import fs from 'node:fs';

const configPath = '.github/dependabot.yml';
const text = fs.readFileSync(configPath, 'utf8');
const blocks = text.split(/\n(?=  - package-ecosystem:)/);
const cargoBlocks = blocks.filter((block) => /package-ecosystem:\s*["']cargo["']/.test(block));

const fail = (message) => {
  console.error(`DEPENDABOT CONFIG ERROR: ${message}`);
  process.exitCode = 1;
};

if (cargoBlocks.length !== 1) {
  fail(`expected exactly one Cargo update block, found ${cargoBlocks.length}.`);
} else {
  const cargo = cargoBlocks[0];
  if (!/^\s*directories:\s*$/m.test(cargo)) {
    fail('Cargo updates must use one multi-directory configuration so mirrored manifests move together.');
  }

  const requiredDirectories = ['/src-tauri', '/node-linux'];
  for (const directory of requiredDirectories) {
    const escaped = directory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const entry = new RegExp(`^\\s*-\\s*["']?${escaped}["']?\\s*$`, 'm');
    if (!entry.test(cargo)) {
      fail(`Cargo Dependabot coverage is missing ${directory}.`);
    }
  }

  if (/^\s*directory:\s*["']?\/src-tauri["']?\s*$/m.test(cargo)) {
    fail('Cargo Dependabot regressed to single-directory /src-tauri coverage.');
  }
}

if (!process.exitCode) {
  console.log('Dependabot Cargo policy: desktop and isolated headless manifests are updated together.');
}
