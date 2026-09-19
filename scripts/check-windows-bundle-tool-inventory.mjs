import fs from 'node:fs';

const workflowPath = process.env.KONOFIX_BUNDLE_WORKFLOW ?? '.github/workflows/windows-ci.yml';
const verifierPath = process.env.KONOFIX_BUNDLE_VERIFIER ?? 'scripts/verify-release.ps1';

const fail = (message) => {
  console.error(`WINDOWS BUNDLE INVENTORY ERROR: ${message}`);
  process.exitCode = 1;
};

const extractQuotedArray = (source, variableName, label) => {
  const escaped = variableName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`\\$${escaped}\\s*=\\s*@\\(([\\s\\S]*?)\\r?\\n\\s*\\)`, 'm'));
  if (!match) {
    throw new Error(`${label} array $${variableName} was not found.`);
  }
  const values = [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
  if (values.length === 0) {
    throw new Error(`${label} array $${variableName} is empty.`);
  }
  return values;
};

export const inspectBundleToolInventory = (workflowSource, verifierSource) => {
  const stagedNames = extractQuotedArray(workflowSource, 'testTools', 'Windows CI');
  const verifierPaths = extractQuotedArray(verifierSource, 'toolRelativePaths', 'release verifier');

  const staged = stagedNames.map((name) => `scripts/${name.replaceAll('\\', '/')}`);
  const stagedSet = new Set(staged);
  const verifierSet = new Set(verifierPaths.map((value) => value.replaceAll('\\', '/')));

  if (stagedSet.size !== staged.length) {
    throw new Error('Windows CI $testTools contains a duplicate script entry.');
  }
  if (verifierSet.size !== verifierPaths.length) {
    throw new Error('release verifier $toolRelativePaths contains a duplicate script entry.');
  }

  for (const path of stagedSet) {
    if (!verifierSet.has(path)) {
      throw new Error(`staged operator tool is missing from release verifier: ${path}`);
    }
  }
  for (const path of verifierSet) {
    if (!stagedSet.has(path)) {
      throw new Error(`release verifier requires a tool that Windows CI does not stage: ${path}`);
    }
  }

  for (const required of ['scripts/evidence-snapshot.ps1', 'scripts/path-identity.ps1']) {
    if (!stagedSet.has(required)) {
      throw new Error(`required snapshot dependency is missing from the Windows bundle: ${required}`);
    }
  }

  return { staged, verified: [...verifierSet] };
};

try {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const verifier = fs.readFileSync(verifierPath, 'utf8');
  const result = inspectBundleToolInventory(workflow, verifier);
  console.log(`Windows bundle tool inventory: ${result.staged.length} staged/verified scripts aligned.`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
