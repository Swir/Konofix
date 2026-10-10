<!-- KONOFIX-BETA-PREVIEW -->
# Konofix Chat 0.5.2 Beta 1 — Two-PC P2P / Optional KNP Preview

This is a **tester-only, publication-HELD** Windows candidate for user-led Poland–Norway testing. The reported LAN-to-LTE attempt is **WAN FAIL** ([#165](https://github.com/Swir/Konofix/issues/165)); it is not an unrun test. The exact original tester build/hash was not supplied. This candidate does not claim successful WAN qualification, Global Beta or production readiness. The verified checklist fraction remains **56/67 = 83.6%**, separate from release readiness.

## Download and install

While publication is HELD, use only the agreed green exact-main **Windows CI Actions artifact**. Verify its source SHA, workflow and archive hashes using [TWO_PC_TEST.md](https://github.com/Swir/Konofix/blob/main/docs/TWO_PC_TEST.md). The Actions artifact contains the inner exact-commit ZIP, checksum and installer. It is not a published beta release.

The following release names are reserved for **v0.5.2-beta.1** only after the reviewed publication hold is removed and that prerelease is actually published:
- `Konofix-Chat-0.5.2-beta.1-setup.exe` and its matching `.sha256`;
- the exact-commit `Konofix-Chat-0.5.2-Windows-<40-character-SHA>.zip` and its `.sha256` for the MSI alternative, Node/Netprobe, instructions and evidence tools;
- `BUILD_INFO.json` records the source commit, workflow and sealed file inventory.

The installer/application version is **0.5.2**; **beta.1** names the preview channel. Both testers must use the same source commit and package checksum. Existing 0.5.1 Stable/Beta 1 assets are historical and are not this candidate. The publisher never overwrites an existing published release or moves its tag.

Verify the inner ZIP SHA-256 against its checksum and the installer against BUILD_INFO.json before running it. The outer Actions download has a different hash. Builds are not commercially code-signed. Close older Konofix instances before installing; preserve previous trusted installers for rollback. Do not delete or send profile keys when upgrading or rolling back. After rollback, start a separate test record because the source commit changed.

## Included behavior

Primary direct chat stays on rust-libp2p: TCP/QUIC, Noise/Yamux, GossipSub, Kademlia, mDNS, Identify/Ping, AutoNAT, UPnP, relay/circuit, DCUtR and request/response. There are no accounts, single mandatory history authority or Konofix-owned VPS. Participant relays/bootstrap peers are replaceable discovery/transport helpers. Multiple third-party Nostr relays provide signed, expiring WORLD presence/text when restrictive NAT prevents the native mesh; their operators can observe public WORLD content, and private chat, rooms and files never use this fallback.

Optional KNP contact text runs beside WORLD/rooms/files, with verified NodeIDs, application acknowledgements, exclusive profiles and bounded session state. It has no automatic identity mapping or silent cross-protocol fallback.

Network settings distinguish observed direct TCP/QUIC and circuit connections from relay reservations. Remembered reconnects prefer known direct candidates and allow bounded sequential circuit fallback after a matching failure. Existing DHT discovery/DCUtR policies remain intact; route observations are not per-message GossipSub traces.

## Test procedure and remaining limits

Start with `TWO_PC_TEST.md` in the full ZIP ([source guide](https://github.com/Swir/Konofix/blob/main/docs/TWO_PC_TEST.md)); use `KNP_CHAT_BETA.md` for the optional path and physical acceptance matrix. The generated `TESTER_HANDOFF.md` binds the exact version, source SHA and workflow run.

LAN must discover peers automatically through mDNS without pasted addresses. Internet WORLD must also become automatic without a mandatory operator-owned VPS. The default-on visible session option uses Amino for untrusted direct-first discovery and four replaceable public Nostr relays for signed, expiring WORLD presence/text fallback. A bounded two-client public-relay probe passed, but physical WAN #165 remains FAIL until the new exact-build installer succeeds on both PCs. The empty native bootstrap pool remains optional; public IPFS peers are not compatible chat relays. A manual invitation is diagnostic only. See [COLD_START_DESKTOP.md](https://github.com/Swir/Konofix/blob/main/docs/COLD_START_DESKTOP.md), [WORLD_RELAY_FALLBACK.md](https://github.com/Swir/Konofix/blob/main/docs/WORLD_RELAY_FALLBACK.md) and the exact-build two-PC procedure. KNP still needs separately verified NodeIDs and reachable UDP endpoints.

Preserve the real observation: two installations discovered each other on LAN, then stopped meeting in WORLD after one PC moved to LTE (**WAN FAIL**). That LAN discovery observation does not complete the full message/file/restart acceptance campaign. Start each new physical retest in a fresh evidence folder as **NOT RUN**, without replacing the failure. Direct WAN, controlled relay fallback and two-installation KNP need their own exact-build observations; installed-app tests on one Windows runner and local circuit Ping do not pass those field gates. Load, many-user soak and failover qualification remain separate. Publication remains [HELD](https://github.com/Swir/Konofix/blob/main/docs/BETA_PUBLICATION_HOLD.md), including the unresolved KNP lifecycle investigation, until the actual qualification conditions are met.
