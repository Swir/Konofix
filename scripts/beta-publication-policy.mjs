// Candidate 0.5.2 is qualified only as a public preview. The immutable source
// binding below keeps publication on the exact build that was installed on two
// physical PCs and user-confirmed across independent networks. This does not
// grant Global Beta, KNP, file-transfer, restart or route-level qualification.
const candidate = Object.freeze({
  sourceCommit: '8f6772b8cc0ea448fc31bea74923cee86920ae27',
  windowsRun: '38040689052',
  artifact: 'Konofix-Chat-0.5.2-Windows-8f6772b8cc0ea448fc31bea74923cee86920ae27',
  installerSha256: '8e01ed1753ee999d7ad85ca458f338aa4dbc9666ca1ca36e946bfd30b0cf5a83',
  acceptance: 'docs/evidence/WORLD_WAN_20261010.md',
});

export const betaPublicationPolicy = Object.freeze({
  version: '0.5.2',
  mode: 'qualified-preview',
  reason: 'Exact-build physical two-installation WORLD text was user-confirmed across independent networks; broader route, restart, file, KNP and Global Beta gates remain open.',
  candidate,
});
