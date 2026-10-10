# 0.5.2 public preview qualification

The earlier tester-only publication hold is lifted **only** for the immutable
0.5.2 candidate recorded in `scripts/beta-publication-policy.mjs`. Its exact
source commit, Windows workflow, artifact name and installer SHA-256 are bound
in source. The physical user report is preserved in
[`evidence/WORLD_WAN_20261010.md`](evidence/WORLD_WAN_20261010.md).

That report confirms ordinary public WORLD text communication on two physical
installations across the user's independent-network test. It does not record the
transport subtype, message markers, PeerIDs, restart recovery, file transfer,
private rooms or KNP. Publication is therefore authorized only as a prerelease;
it is not Global Beta or stable qualification and does not raise the verified
56/67 roadmap fraction.

The trusted-main publisher downloads the already accepted Windows artifact by
its immutable workflow run instead of silently substituting a newly compiled
binary. It verifies the inner exact-build archive, `BUILD_INFO.json`, installer
digest and exact candidate Windows/Linux/RustSec checks. Assets are uploaded to
a draft and checked before the prerelease becomes public. Existing published
releases, tags and assets remain immutable.

The unresolved optional KNP lifecycle investigation and every broader field,
load, soak, failover and route-level gate remain open. The original WAN failure
in issue #165 is retained as historical evidence beside the later limited PASS.
