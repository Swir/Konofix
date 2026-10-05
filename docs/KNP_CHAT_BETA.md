# KNP direct-text beta: two-installation test

This candidate adds **KNP direct-contact text chat** to the ordinary Konofix login and chat composer. It is not a Global Beta or production-readiness declaration. WORLD, rooms, files and the optional Node/Netprobe tools use the separate legacy libp2p mode; they do not demonstrate KNP message delivery.

## Select and verify the exact build

1. Download the successful **Windows CI** artifact for the agreed commit. For the integrated candidate, use the `main` run. A pull-request artifact identifies GitHub's temporary merge commit, which can differ from the PR head.
2. Keep the inner `Konofix-Chat-...-Windows-<commit>.zip` beside its `.sha256` file. Compare `Get-FileHash -Algorithm SHA256 <zip>` with that checksum before extracting it.
3. Open `BUILD_INFO.json` and `TESTER_HANDOFF.md`. Record the complete source commit, workflow run, version, ZIP SHA-256 and installer filename. Both testers must use the same bundle. Do not substitute a historical beta release with the same version number.
4. Install the NSIS `*-setup.exe` or MSI from `bundle`. Windows CI verifies both installer payloads and exercises the NSIS-installed application. It does not establish that an unsigned installer is trusted by SmartScreen on every computer.

## Two Windows computers on one LAN

1. Start the installed **Konofix Chat** application on A and B. Choose **KNP direct contacts (beta)**, distinct display nicknames and a local profile (for example `default`). A profile preserves its KNP identity across restarts. Separate profiles generate separate identities. One profile cannot be open in two processes at once.
2. Open **Contacts & my NodeID** on each computer. Exchange the full `knp1...` NodeID through a trusted channel and verify it out of band. Names are local labels, not globally reserved identities.
3. Note the displayed UDP port. `0.0.0.0` is the bind address, not an address to share. Use `ipconfig` to identify that computer's active LAN IPv4 address and combine it with the displayed port, for example `192.168.1.20:54321`. Use the actual value observed on that computer. Allow the installed app on the intended Windows Firewall network when prompted; do not disable the firewall.
4. **Both** people add the other NodeID, IP:port and a local contact label. Select that contact in the sidebar. Receiving a transport packet from someone you have not added does not admit their chat message.
5. A sends a unique, harmless marker such as `A-to-B <timestamp> <random suffix>`, including an emoji. B verifies the exact text in the normal chat window; A verifies **Received by application**. Repeat B to A. Also send literal `<script>` text and verify it displays as text.
6. Send several messages while typing another draft; confirm the draft is preserved. Try an unavailable endpoint/contact and confirm that queued/unconfirmed/failed delivery is not presented as application acceptance. Do not mark this scenario PASS merely because the Send button returned.
7. Disconnect A, then reopen the same profile. Confirm that its NodeID stays the same while contacts and history are empty. Reopen Contacts, exchange the current UDP port, add B again, and update A's endpoint on B if it changed. Repeat both directions. Repeat after fully closing and reopening the application.
8. Close one application and verify the other does not falsely report new messages as received by an application. If a send has an uncertain result, check the recipient before manually sending it again: a new click creates a new message ID.

### Interpret status literally

| Status | Evidence provided |
| --- | --- |
| Queued | The local SDK accepted the send request. |
| Transport delivered; application not confirmed | KNP acknowledged transport delivery. The receiver's chat session has not confirmed admission. |
| Received by application | The admitted remote KNP chat session acknowledged this message. This is not a read receipt from a person. |
| Delivery unconfirmed / Transport reported failure | Delivery is not established. A late valid application acknowledgement may still resolve the status. |

The beta retains at most 512 messages, 16 contacts and 64 pending sends per session. Contacts and history are in memory and disappear on disconnect. Identity and routing state remain under `%LOCALAPPDATA%\Konofix Chat\KonoNexus\chat-profiles\<profile>`. **Never share `identity.key` or a copy of the profile directory.**

## Independent networks / WAN: separate, still-required evidence

After the two-computer LAN test, repeat with two independently installed applications on genuinely different networks. Record the actual network arrangement, NAT/CGNAT conditions and the contact endpoints used. A LAN address is not an Internet contact. This initial UI accepts exact IP:port contacts; it does not provide a rendezvous, invite or relay-discovery UI. A reachable UDP endpoint or an appropriate operator-controlled port mapping may be required. Do not claim automatic NAT traversal or WAN success when only loopback/LAN was tested.

Do not reuse legacy TCP/QUIC Netprobe results as KNP evidence. A Windows CI result is bounded to its observed scope: two processes on one disposable Windows runner, real loopback UDP, production SDK policy, real installed frontend/IPC, text delivery and session lifecycle. It is not a physical two-device or independent-network test.

## Record actual observations

Keep a report and screenshots from both installations. Start every outcome as **NOT RUN**; replace it only after the observation exists. Record:

- Full source SHA, Windows workflow run, ZIP SHA-256, installer and OS versions.
- A/B NodeIDs (public identifiers), topology (same LAN or independent networks), test time with timezone and actual endpoint/port changes. Keep sensitive network details in the private test report when appropriate.
- Unique message markers and screenshots of the receiving window plus sender application-acknowledged status in each direction.
- Disconnect/restart, identity preservation, cleared history, endpoint refresh and post-restart messages.
- Unavailable-peer behavior, any lost/duplicate/out-of-order messages, crashes or confusing UI, with exact reproduction steps.
- An explicit scope statement: loopback, two-device LAN, or independent-network WAN. Do not infer an untested scope from another result.

Do not edit the bundle's sealed inventory or fabricate evidence files. Report the KNP observations separately from the existing legacy Global Beta qualification gates. Passing this text-chat test does not qualify files, rooms, voice, many-user soak or production operation.
