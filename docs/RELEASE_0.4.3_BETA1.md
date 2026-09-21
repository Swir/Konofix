<!-- KONOFIX-BETA-PREVIEW -->
# Konofix Chat 0.4.3 Beta 1 — Room Stability Preview

This prerelease is the next user-requested Windows beta for manual testing. Connected desktops still form the participant-operated P2P network and the separate headless Konofix Node remains optional. **Global Beta qualification remains 56/67 = 83.6%.**

## What changed

- Fixed the UI freeze after creating an owned password-protected room. Secure-room DOM augmentation is now coalesced and idempotent instead of re-triggering itself through the MutationObserver.
- Room creation now uses one in-app Rooms 2.0 dialog for the room name and optional password instead of chained browser prompts.
- Direct file transfers started inside a non-WORLD room now carry room context. Sender and receiver see that context, and protected-room transfers fail closed when the local node can prove the sender/receiver is not authorized for that room.
- Kept the duplicate-nickname hotfix: the already active authenticated user keeps the nickname and a later duplicate login is rejected.
- Includes password-protected rooms, authenticated private 1:1 chat, custom Konofix emoji/emoticons, selectable nickname colors, and WORLD file/image offers with explicit download/preview.

## Manual test focus

Use the same 0.4.3 build on both computers.

1. Create public and password-protected rooms and confirm the UI stays responsive.
2. Join a protected room first with a wrong password, then the correct password.
3. Exchange room chat messages in both directions.
4. Send a file from inside the protected room in both directions; verify Accept/Reject, progress and final SHA-256 completion.
5. Confirm a duplicate nickname login rejects the later user without disconnecting the incumbent.
6. Exercise private 1:1 messages, emoji, nickname colors, WORLD file sharing and image preview/download.

Incoming files are never executed automatically. Keep this build's installer/ZIP, BUILD_INFO.json and checksum files together. Report the exact source commit from BUILD_INFO.json with any failure.
