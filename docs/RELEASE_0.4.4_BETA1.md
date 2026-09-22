<!-- KONOFIX-BETA-PREVIEW -->
# Konofix Chat 0.4.4 Beta 1 — Secure Chat Accessibility Preview

This prerelease is reserved for the next qualified Windows beta after the frozen 0.4.3 room-stability candidate. Connected desktops remain the participant-operated P2P network and the separate headless Konofix Node remains optional. **Global Beta qualification remains 56/67 = 83.6%.**

## Qualification gate

This handoff note does **not** make 0.4.4 ready by itself. The candidate may be handed to the user only after the exact PR head passes Windows CI, Linux Node CI and RustSec, that exact qualified head is merged, the resulting exact `main` commit passes the same three gates, and a Windows installer/artifact is verified against that exact `main` commit. The frozen 0.4.3 build remains the user's first manual-test candidate and must not be rebuilt or replaced by 0.4.4 work.

## Test order

1. Complete manual testing of the frozen 0.4.3 candidate first.
2. Keep that exact 0.4.3 installer/ZIP and its `BUILD_INFO.json` unchanged for reproducibility.
3. Move to 0.4.4 only after the project reports that a verified Windows installer exists for the exact qualified 0.4.4 `main` commit.
4. Use the same qualified 0.4.4 build on both computers during the 0.4.4 test pass.

## What changed

- Improved protected-room and private-chat layouts for short and narrow windows without changing room, password or P2P semantics.
- Added explicit keyboard focus states, Escape dismissal for secure dialogs and focus restoration to the initiating control or peer.
- Added coarse-pointer touch targets of at least 44 px and safe-area handling for full-screen private chat.
- Added Windows High Contrast / forced-colors support for secure-room and private-chat controls and unread badges.
- Respects the operating system reduced-motion preference by disabling nonessential secure/private UI transitions and smooth scrolling.
- Preserves the 0.4.3 behavior set: password-protected rooms, authenticated private 1:1 chat, duplicate-nickname incumbent ownership, emoji, nickname colors, WORLD file/image sharing and room-context direct file transfers.

## Manual test focus

Use the same 0.4.4 build on both computers once this candidate is qualified.

1. Re-run the 0.4.3 protected-room, wrong-password/correct-password and room file-transfer scenarios.
2. Resize the window to short and narrow desktop sizes and confirm protected-room creation and private chat remain usable without clipped primary controls.
3. Navigate secure dialogs with the keyboard, close them with Escape and confirm focus returns to the initiating control.
4. Enable Windows High Contrast / forced colors and confirm focus, buttons, inputs and unread indicators remain visible.
5. Enable reduced motion in the operating system and confirm secure/private UI does not animate or smooth-scroll unnecessarily.
6. Re-check private 1:1 messaging, emoji, nickname colors, duplicate nickname rejection, WORLD file/image sharing and protected-room file transfers for regressions.

Incoming files are never executed automatically. Keep the installer/ZIP, BUILD_INFO.json and checksum files together and report the exact source commit from BUILD_INFO.json with any failure.
