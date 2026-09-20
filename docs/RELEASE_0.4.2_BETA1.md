<!-- KONOFIX-BETA-PREVIEW -->
# Konofix Chat 0.4.2 Beta 1 - P2P Preview

A beta preview for testing participant-operated P2P chat. Every connected desktop participates in the network; a separate headless Konofix Node is optional. **Global Beta qualification remains open: 55/67 = 82.1%.** This release gathers real-world results and does not claim that the remaining network gates have passed.

## Download and start

1. Download **Konofix-Chat-0.4.2-beta.1-setup.exe** and its matching `.sha256` file.
2. Verify SHA-256, install, then open **Konofix Chat** from the Start menu.
3. Choose a nickname and connect. Applications on the same LAN discover each other automatically.
4. For first contact over the Internet, exchange a reachable participant address in network settings. NAT/CGNAT may require port forwarding or another reachable participant that relays connections.

The full ZIP includes the MSI alternative, optional Node and Netprobe tools, and testing instructions. **Netprobe is a command-line diagnostic tool; it does not open the chat.** The application version remains `0.4.2`; `beta.1` identifies this release channel.

## Changes

- Fixed missing remote chat messages: timestamped chat and nickname claims now decode correctly inside signed network events.
- Fixed accepted binary file transfers failing with an outbound-stream EOF: the bounded request limit now includes CBOR's encoded size, preserving the existing file protocol.
- Added regression coverage using two real application network loops: WORLD/room chat, multi-chunk binary transfers in both directions, saved-byte/SHA-256 verification, empty files and rejected offers.
- Fixed Windows packaging: the Start menu opens Chat instead of Netprobe. CI checks real MSI/NSIS payloads, installation, the rendered login form and the window's event subscriptions.
- Automatic LAN connections, discovery of relay-capable participants and copying participant addresses.
- Rooms 2.0 membership/count synchronization, acknowledged room changes, periodic room/presence announcements and disconnect cleanup.
- Exact-build evidence tools for multi-participant, multi-network, load and failover tests, shipped with the test bundle.

## Qualification still pending

Real tests across 20 computers, five networks and three countries, 50/100/250-client load, and participant failover have not yet been qualified. Source CI is not a substitute. WORLD and rooms are public: encrypted transport does not make them private E2E conversations. There is no central availability service; the network depends on its connected participants.

Update **both sending and receiving computers** to this package. Historical `test1` and `test2` builds contain the chat/file defects fixed here. Keep the matching ZIP, checksum, `BUILD_INFO.json`, tools and evidence together; do not mix build files. See `TESTER_HANDOFF.md`, `TESTING.md` and `GLOBAL_BETA.md` in the ZIP. The optional `validate-global-beta-evidence.mjs` evidence tool requires Node.js 22+ on the evidence collector's computer; the desktop chat does not require Node.js.

Report the source commit from `BUILD_INFO.json`, reproduction steps and observed results. Never publish `node-identity.key`. Keep a previously verified installer separately; if an update regresses, close the app and reinstall that known version without mixing files from different packages.
