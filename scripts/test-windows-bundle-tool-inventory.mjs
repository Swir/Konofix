import { inspectBundleToolInventory } from './check-windows-bundle-tool-inventory.mjs';

const workflow = `
      - name: Stage Windows test bundle
        shell: pwsh
        run: |
          $testTools = @(
            'internet-test.ps1',
            'evidence-snapshot.ps1',
            'path-identity.ps1'
          )
`;

const verifier = `
  $toolRelativePaths = @(
    'scripts/internet-test.ps1',
    'scripts/evidence-snapshot.ps1',
    'scripts/path-identity.ps1'
  )
`;

const expectPass = (label, workflowSource, verifierSource) => {
  try {
    inspectBundleToolInventory(workflowSource, verifierSource);
  } catch (error) {
    throw new Error(`${label}: expected PASS, got ${error instanceof Error ? error.message : String(error)}`);
  }
};

const expectFail = (label, workflowSource, verifierSource, expectedMessage) => {
  let failed = false;
  try {
    inspectBundleToolInventory(workflowSource, verifierSource);
  } catch (error) {
    failed = true;
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes(expectedMessage)) {
      throw new Error(`${label}: wrong failure: ${message}`);
    }
  }
  if (!failed) throw new Error(`${label}: expected failure but inventory checker returned PASS.`);
};

expectPass('aligned baseline', workflow, verifier);
expectFail(
  'staged helper cannot disappear from verifier',
  workflow,
  verifier.replace("    'scripts/evidence-snapshot.ps1',\n", ''),
  'missing from release verifier',
);
expectFail(
  'verifier cannot require an unstaged tool',
  workflow.replace("            'internet-test.ps1',\n", ''),
  verifier,
  'Windows CI does not stage',
);
expectFail(
  'staging cannot duplicate tools',
  workflow.replace("            'internet-test.ps1',\n", "            'internet-test.ps1',\n            'internet-test.ps1',\n"),
  verifier,
  'duplicate script entry',
);
expectFail(
  'snapshot helper is mandatory',
  workflow.replace("            'evidence-snapshot.ps1',\n", ''),
  verifier.replace("    'scripts/evidence-snapshot.ps1',\n", ''),
  'required snapshot dependency',
);

console.log('Windows bundle tool inventory adversarial self-tests: PASS');
