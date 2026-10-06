# 0.5.2 public publication hold

The 0.5.2 Windows candidate is **tester-only**. The ordinary Windows workflow
may build, verify and upload an installable Actions bundle, but the publisher's
CLI records HELD and exits before reading a token, release plan or GitHub API.
No release, tag or public asset is created by that entry point.

The source-owned policy is `scripts/beta-publication-policy.mjs`. There is no
environment-variable switch or scheduled task that releases this hold.
Removing it requires a reviewed code change, reliable exact-main Windows CI
(including the unresolved KNP lifecycle failure) and the user's actual physical
two-installation results. Those results must identify the exact candidate,
checksums, topology and observed direct/circuit behavior; cloud two-process
acceptance is insufficient. See [TWO_PC_TEST.md](TWO_PC_TEST.md).

This hold does not modify existing immutable releases or their tags/assets.
It does not disable builds, tests, artifact verification or tester downloads.
The retained publisher qualification tests still cover exact source/CI,
asset integrity, resumable drafts and immutable published releases. A new test
executes the real held CLI without a token or release plan and checks that it
only writes its hold summary.

Main Windows qualification and physical LAN/WAN/relay results remain separate
gates. Neither this policy nor a later green build marks any field test PASS.
