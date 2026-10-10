# KNP accepted-stop acknowledgement barrier

PR #178 Windows run 37656964513 failed at the original restart test after
compilation completed in 5m24s. Head was
`9ade685df84583d5cbe2a089d8ea776f25b446be`, tested merge source
`577b549f6b54002c8c7847ac293daba553e6d07c`. The unchanged 15-minute all-target
limit stopped the run. Passive samples remained at `reject stale handle` from
2040ms through 574904ms. The original [sample and manifest](evidence/knp-178/manifest.json)
are preserved byte-for-byte; [Actions artifact](https://github.com/Swir/Konofix/actions/runs/37656964513/artifacts/11500401358).
Archive SHA-256: `9cf9b49b960ce1a12993f03a14e0e85e6c2d293415e41252e6a8e55d06fb707a`.

The actor acknowledged stop while its command receiver and interval were still
alive. A resumed caller could enqueue a stale command during that cleanup window.
The chat and SDK bridge now close and drop command receivers before SDK shutdown,
dropping queued reply senders at that boundary. The chat also drops its event
receiver and interval before releasing the profile lock and acknowledging stop.
The SDK shutdown is still awaited; no abort/timeout is added to hide a stuck wait.

A test-only command holds the actual actor immediately after its stop acknowledgement.
The new regression checks that admission is closed, a queued response is dropped,
a stale send fails and the real UDP socket can be rebound even while that task
is held. With the old cleanup order and the same scheduling gate, the assertion
`stop acknowledged before command admission closed` fails deterministically.
With the change it passes. The gate is absent from release builds and never used
by the original restart test or its 24-process Windows batch.

Local comparison used the actual actor source in a separate Linux harness with
the product SDK pin `ea9cc5dfffa7480ab5a1bb0f79e8b5649fdeea3e` and Tokio 1.53.2.
It is not Windows evidence. Windows exact-head, the existing original captured
batch and post-merge CI remain required. Sampling identifies a waiting boundary,
not a thread stack: this patch fixes a reproduced acknowledgement contract defect,
but does not prove the internal scheduler/lock cause of this or every historical
KNP timeout. Failed attempts remain evidence and are not rerun away.

The PR includes #178's two-file CI order correction: all-target compilation/tests
precede the standalone timer regression. All existing deadlines, test selection,
original parallelism/capture and the production SDK pin are unchanged.
The later exact WORLD candidate is qualified for a public prerelease by a limited
physical text PASS. This historical KNP barrier remains unresolved and is not
reclassified by the WORLD result.
