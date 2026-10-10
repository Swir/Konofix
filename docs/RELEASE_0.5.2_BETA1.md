<!-- KONOFIX-BETA-PREVIEW -->
# Konofix Chat 0.5.2 Beta 1 — Two-PC P2P / Optional KNP Preview

This is a **qualified prerelease preview**, bound to exact source commit `8f6772b8cc0ea448fc31bea74923cee86920ae27`. After the earlier LAN-to-LTE failure, the user installed this exact candidate on the two physical PCs in the continuing independent-network test and reported that normal typed communication now works. The limited [acceptance record](https://github.com/Swir/Konofix/blob/main/docs/evidence/WORLD_WAN_20261010.md) does not contain route subtype, message-marker, restart, file, private-room or KNP evidence. This candidate therefore does not claim Global Beta or production readiness. The verified checklist fraction remains **56/67 = 83.6%**, separate from preview availability.

## Download and install

Download **v0.5.2-beta.1** from GitHub Releases and verify the published checksum. The release contains the accepted setup executable plus the exact-commit ZIP, checksum and `BUILD_INFO.json`. Use [TWO_PC_TEST.md](https://github.com/Swir/Konofix/blob/main/docs/TWO_PC_TEST.md) for continued observations.

The prerelease publishes these names:
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

LAN discovers peers automatically through mDNS without pasted addresses. Internet WORLD should also become automatic without a mandatory operator-owned VPS. The default-on visible session option uses Amino for untrusted direct-first discovery and four replaceable public Nostr relays for signed, expiring WORLD presence/text fallback. A bounded two-client public-relay probe passed, and the user later confirmed typed WORLD communication on two physical installations across the independent-network retest with this exact candidate. The physical transport subtype was not recorded. The empty native bootstrap pool remains optional; public IPFS peers are not compatible chat relays. A manual invitation is diagnostic only. See [COLD_START_DESKTOP.md](https://github.com/Swir/Konofix/blob/main/docs/COLD_START_DESKTOP.md), [WORLD_RELAY_FALLBACK.md](https://github.com/Swir/Konofix/blob/main/docs/WORLD_RELAY_FALLBACK.md) and the exact-build two-PC procedure. KNP still needs separately verified NodeIDs and reachable UDP endpoints.

Preserve both real observations: the earlier installations stopped meeting in WORLD after one PC moved to LTE (**WAN FAIL**), while the later exact candidate restored user-reported typed communication across the independent-network test (**limited PASS**). Neither result completes the full message/file/restart acceptance campaign. Start each additional physical retest in a fresh evidence folder without replacing either observation. Direct WAN, controlled relay fallback and two-installation KNP need their own exact-build route evidence; installed-app tests on one Windows runner and local circuit Ping do not pass those field gates. Load, many-user soak, failover and the unresolved KNP lifecycle investigation remain separate.
