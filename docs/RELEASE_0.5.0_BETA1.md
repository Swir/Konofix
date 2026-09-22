<!-- KONOFIX-BETA-PREVIEW -->
# Konofix Chat 0.5.0 Beta 1 — Room & Private Sharing Preview

This prerelease is the user-requested 0.5 Windows beta for manual testing after the frozen 0.4.3/0.4.4 candidates. Connected desktops remain participant-operated P2P nodes; the separate headless Konofix Node remains optional. **Global Beta qualification remains 56/67 = 83.6%.**

## What changed

- Non-WORLD rooms now share files as room-scoped offer cards instead of opening the global peer recipient chooser.
- Room offers carry bounded, backward-compatible room context. File bytes are transferred only after an explicit download request over the existing direct P2P file-transfer protocol.
- Protected-room offer publication, reception, claims and final file offers fail closed when local authoritative room-security state proves a participant unauthorized.
- Authenticated private 1:1 chat now has a direct attachment button targeting the active conversation peer without another recipient-selection step.
- Private chat received clearer peer status, refreshed message bubbles and a compact picker that reuses the existing safe Konofix emoji/text renderer.
- Existing duplicate-nickname incumbent ownership, password rooms, private-message authentication, WORLD file/image sharing, Accept/Reject, cancellation, size limits, SHA-256 verification, no-clobber finalization and dangerous-file warnings remain required.

## Manual test focus

1. In a public temporary room, click Send file and confirm no global recipient chooser appears; every participant in that room should see the offer card.
2. Repeat in a password-protected room with two authorized participants; verify an unauthorized participant cannot consume the protected-room transfer.
3. Download room offers in both directions and verify Accept/Reject, progress, cancellation and final SHA-256 completion.
4. Open a private 1:1 conversation and use the attachment button; confirm the file targets that conversation peer directly.
5. Exercise private text, emoji, unread state, reconnect behavior, nickname colors and the refreshed private-chat UI.
6. Re-check duplicate nickname rejection, WORLD file/image offers and protected-room create/join/password-change behavior.

Keep the installer/ZIP, BUILD_INFO.json and checksum files together and report the exact source commit from BUILD_INFO.json with any failure.
