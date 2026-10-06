// Candidate 0.5.2 is intentionally tester-only. Changing this policy requires
// a reviewed PR with reliable exact-main Windows qualification and real
// two-installation evidence. CI alone cannot authorize public publication.
export const betaPublicationPolicy = Object.freeze({
  version: '0.5.2',
  mode: 'tester-only',
  reason: 'Unresolved main KNP lifecycle timeout and missing physical two-PC acceptance.',
});
