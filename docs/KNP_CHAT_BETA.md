# Primary P2P chat + optional KNP: two-installation acceptance

Ordinary Konofix login uses **rust-libp2p**. WORLD, rooms, private control and files retain TCP/QUIC, Noise/Yamux, GossipSub, Kademlia DHT, mDNS, Identify/Ping, AutoNAT, UPnP, circuit relay, DCUtR and direct request/response. KonoNexus/KNP is an additional contact-text panel. This candidate is not a Global Beta or production-readiness declaration.

There are no accounts, central message server or central history. Every connected app is a peer. Bootstrap and relay participants are replaceable transport/discovery helpers, not identity/history authorities. Public WORLD remains public to participants. Private room, direct control and file authorization retain their existing contracts.

## Verify the exact build

1. Use the successful **Windows CI** artifact for the agreed full commit. Prefer the integrated `main` run. A PR artifact identifies GitHub's temporary merge commit, which can differ from its head.
2. Keep the inner `Konofix-Chat-...-Windows-<commit>.zip` with its `.sha256`; compare `Get-FileHash -Algorithm SHA256 <zip>` before extraction.
3. Record `BUILD_INFO.json` / `TESTER_HANDOFF.md`: full source commit, workflow run, version, ZIP hash and installer. Both testers use the same bundle, not a historical release with the same version.
4. Install the NSIS `*-setup.exe` or MSI. CI verifies both payloads and exercises the NSIS-installed app; it does not establish SmartScreen trust on every PC. Allow the installed app on the intended Windows Firewall network when prompted; do not disable the firewall.

## Required primary-network acceptance

Start each result as **NOT RUN**. Same-host cloud tests cannot fill the physical-network rows below.

| Scenario | Setup and action | Required observations |
| --- | --- | --- |
| Two-PC LAN, zero configuration | Two physically distinct Windows PCs on the same multicast-capable LAN, fresh application network settings/cache, no bootstrap or pasted addresses. Log in with different nicknames. | Both appear automatically through mDNS. Send unique WORLD markers and replies; receive exact text. Record actual direct connection addresses/status. Create/join a room, transfer an approved small file and compare SHA-256. Restart one app and repeat. |
| Direct WAN where NAT permits | Two PCs on genuinely independent networks, reachable first contact via existing cache/participant invitation/bootstrap. Record NAT/UPnP conditions. Use the existing TCP and QUIC Netprobe procedures as transport evidence alongside app messages. | Record direct TCP/QUIC addresses and actual successful app messages both ways. Record DCUtR only if an observed hole-punch upgrade occurs. A connected peer count or successful TCP probe alone is not QUIC/DCUtR proof. |
| Controlled relay fallback | Same independent-network pair, with direct reachability actually unavailable and an identified reachable participant relay. Document the restriction/NAT and direct attempt failure, without disabling general host protection. | Establish an authenticated circuit route and exchange app messages both ways. Record relay PeerID/circuit address. Restore a direct path and observe recovery/upgrade where supported; record failures honestly. Remove/change the relay and verify bounded recovery without identity/history service dependence. |

On LAN, mDNS must work without manual addresses. If guest-Wi-Fi isolation, VLAN boundaries or blocked multicast prevent discovery, record that environment and the failure; do not silently paste an address and mark zero-config PASS. Across the Internet, two fresh isolated peers still need a reachable first contact. DHT is decentralized discovery, not a way to discover an unknown network from nothing. The default bundled bootstrap pool is empty. Typical returning peers use learned addresses; a first invitation/bootstrap may be necessary. CGNAT/symmetric NAT may require a relay. Do not label these prerequisites as a central message server or promise universal direct connectivity.

A relay reservation only means a circuit can be requested; it is not evidence that a message travelled over relay. Existing retries and relay selection are bounded. Do not confuse a direct connection to the relay participant with a direct end-to-end connection to the intended recipient. Use the existing network evidence tools and attach actual observations; do not fabricate route evidence from UI labels.

## Optional KNP alongside the primary network

1. Complete primary LAN discovery and bidirectional WORLD messaging first. On each PC choose **Optional KNP contacts**, then a local profile such as `default`. One profile cannot be open in two processes at once. It preserves a KNP identity across restarts.
2. Open **Contacts & my NodeID**. Exchange and verify the full `knp1...` identity out of band. Labels are local names. A KNP NodeID is not implicitly bound to a libp2p PeerID.
3. Read the displayed UDP port. `0.0.0.0` is a bind address, not a shareable address. Combine the observed port with that PC's reachable IP (LAN example: `192.168.1.20:54321`). Both sides add the other's verified NodeID, exact endpoint and label. This initial optional path requires explicit contacts; primary mDNS remains automatic.
4. Select the contact, exchange unique harmless markers in both directions, including emoji and literal `<script>` text. Verify exact incoming text and **Received by application** at the sender. Unknown contacts are not admitted even if transport delivery succeeds.
5. Choose **Back to WORLD** on each PC. Send ordinary WORLD messages both ways while KNP remains active; reopen KNP and exchange more text. No recipient mapping, automatic cross-protocol resend or duplicate delivery should occur.
6. Stop only KNP and verify WORLD still works. Reopen the same KNP profile: same NodeID, new session, empty contacts/history. Exchange current UDP ports, add/update contacts and repeat messages.
7. Disconnect the primary network while KNP is active, reconnect, and reopen the profile. The old child must be gone and the profile available; old session IPC must not stop the new one. Repeat after closing and reopening the application.
8. Test unavailable contacts, profile-in-use errors and drafts typed during a pending send. Errors must not interrupt WORLD or falsely claim application receipt. Check the recipient before manually retrying an uncertain send: a new click creates a new message ID.

| KNP status | Evidence |
| --- | --- |
| Queued | Local SDK accepted the request. |
| Transport delivered; application not confirmed | Transport acknowledged delivery; remote chat admission has not been confirmed. |
| Received by application | The admitted remote KNP chat session acknowledged this message, not a human read receipt. |
| Delivery unconfirmed / Transport reported failure | Delivery is not established. A late valid application acknowledgement may resolve it. |

The optional actor retains up to 512 messages, 16 contacts and 64 pending sends. History and contacts are in memory until it stops. Identity/routing state stays under `%LOCALAPPDATA%\Konofix Chat\KonoNexus\chat-profiles\<profile>`. Never share `identity.key` or the profile directory. KNP WAN needs separately observed reachable UDP endpoints; this UI does not implement automatic KNP rendezvous or relay discovery. Do not reuse libp2p Netprobe evidence as KNP evidence.

## Evidence and honest limits

Record the full source SHA, workflow run, ZIP hash, installer/OS versions, public PeerIDs/NodeIDs, topology, timezone, actual connection addresses and endpoint changes. Keep sensitive network details private. Attach unique message markers/screenshots from both recipients, receipt states, restart observations, file hashes, and exact reproduction steps for failures.

Cloud coverage is bounded to real production swarms and two installed-app processes on one Windows runner: local mDNS/WORLD, loopback KNP, IPC/UI, ownership cleanup and receipts. It is **not** two physical PCs, independent WAN, NAT/CGNAT traversal or a relay field PASS. Leave those results NOT RUN until tested. Do not alter sealed bundle manifests or invent evidence files. Existing Global Beta load, soak, multi-country and security qualification gates remain separate and unchanged.
