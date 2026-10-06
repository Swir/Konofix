<!-- KONOFIX-BETA-PREVIEW -->
# Konofix Chat 0.5.2 Beta 1 — Two-PC P2P / Optional KNP Preview

This is an installable Windows preview for user-led Poland–Norway testing. It does not claim successful WAN qualification, Global Beta or production readiness. Verified qualification remains **56/67 = 83.6%**.

## Download and install

Use the assets attached to **v0.5.2-beta.1** only after that prerelease is published:
- `Konofix-Chat-0.5.2-beta.1-setup.exe` and its matching `.sha256`;
- the exact-commit `Konofix-Chat-0.5.2-Windows-<40-character-SHA>.zip` and its `.sha256` for the MSI alternative, Node/Netprobe, instructions and evidence tools;
- `BUILD_INFO.json` records the source commit, workflow and sealed file inventory.

The installer/application version is **0.5.2**; **beta.1** names the preview channel. Both testers must use the same source commit and package checksum. Existing 0.5.1 Stable/Beta 1 assets are historical and are not this candidate. The publisher never overwrites an existing published release or moves its tag.

Verify SHA-256 against the release asset/checksum before running the installer. Builds are not commercially code-signed. Close older Konofix instances before installing; preserve previous trusted installers for rollback. Do not delete or send profile keys when upgrading or rolling back. After rollback, start a separate test record because the source commit changed.

## Included behavior

Primary chat stays on rust-libp2p: TCP/QUIC, Noise/Yamux, GossipSub, Kademlia, mDNS, Identify/Ping, AutoNAT, UPnP, relay/circuit, DCUtR and request/response. There are no accounts, central message server or central history. Participant relays/bootstrap peers are replaceable discovery/transport helpers.

Optional KNP contact text runs beside WORLD/rooms/files, with verified NodeIDs, application acknowledgements, exclusive profiles and bounded session state. It has no automatic identity mapping or silent cross-protocol fallback.

Network settings distinguish observed direct TCP/QUIC and circuit connections from relay reservations. Remembered reconnects prefer known direct candidates and allow bounded sequential circuit fallback after a matching failure. Existing DHT discovery/DCUtR policies remain intact; route observations are not per-message GossipSub traces.

## Test procedure and remaining limits

Start with `TWO_PC_TEST.md` in the full ZIP ([source guide](https://github.com/Swir/Konofix/blob/main/docs/TWO_PC_TEST.md)); use `KNP_CHAT_BETA.md` for the optional path and physical acceptance matrix. The generated `TESTER_HANDOFF.md` binds the exact version, source SHA and workflow run.

LAN must discover peers automatically through mDNS without pasted addresses. Independent Internet networks need a reachable first contact, invitation or bootstrap; the bundled bootstrap pool is empty. NAT/CGNAT may require an identified participant relay. KNP currently needs explicit verified NodeIDs and reachable UDP endpoints.

Physical two-PC LAN, direct WAN, controlled relay fallback and two-installation KNP remain **NOT RUN** until testers return actual observations. Installed-app tests on one Windows runner and local circuit Ping do not pass those field gates. Load, many-user soak and failover qualification remain separate.
