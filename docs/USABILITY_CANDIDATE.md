# Konofix 0.6.1-rc.1 — usability candidate

This is a candidate for testing, not a new stable release. Stable 0.6.0 remains the published baseline. No additional Global Beta qualification credit is claimed.

## Included

- Graphite surfaces, readable messages, configurable text size/accent/spacing, collapsible participants and transfers, favorites in the sidebar, call duration and clear call actions.
- Settings split into Appearance, Sound, Privacy, Connection and Updates. Technical network details are expandable. Diagnostics distinguish text availability from media reachability.
- Favorites, 128-bit identity comparison code plus full identity, manual verification, persistent blocks and local muting. Identities are never merged by nick or an unauthenticated cross-protocol claim. A native identity and a Nostr identity are separate contacts.
- Contact-only incoming messages/calls/files and bounded invitation notifications (3 per identity and 12 globally per minute). Explicitly requested public downloads retain their own consent and metadata checks. Local blocks cannot prevent someone generating a new identity; contact-only mode is available for that case.
- Optional encrypted local private history: at most 2000 messages, AES-256-GCM, random 16-byte PBKDF2 salt, 310000 SHA-256 iterations, fresh 12-byte IV per write, authenticated format context. A passphrase of at least 12 characters is required. Neither passphrase nor derived key is stored. No recovery is possible without the passphrase. Contacts/preferences are local plaintext; message history is encrypted. An unlocked app necessarily has plaintext in memory. Locking clears loaded conversations; deletion removes saved history and invalidates pending saves.
- New WebRTC peers negotiate resume support. Pausing retains the accepted partial file; a new encrypted connection must use the same peer identity, token, name, size and hash. The receiver resumes from the disk-verified offset and still verifies the whole SHA-256 before final save. Older peers continue their original protocol without showing unsupported pause controls. Retention is 30 minutes and lasts only within the running apps, not across restarts. Native/libp2p and legacy small relay transfers retain their existing behavior.
- User-supplied TURN addresses and expiring credentials stay in memory, never in localStorage, logs or shared history. The UI requires an actual relay candidate before enabling the configuration. Allocation confirms the server accepted credentials; it does not prove connectivity to another participant. Configuration applies to new private, file and group connections. Expired relay-only credentials stop new WebRTC connections instead of silently falling back to direct routes. No hosted TURN service is silently provisioned.

## Verification

Run `npm run audit`, `npm run build`, `npm run test:experience`, `npm run test:peer-transport`, `npm run test:group-voice`, and the repository Rust checks. Peer tests exercise sender- and receiver-initiated pause/reconnect with complete byte and hash verification, and reject identity/metadata substitution. Browser UI testing uses `preview.html` and isolated synthetic IPC data; it never contacts public chat users and is not included in the production build.

The new controls provide Polish and English wording. Existing seven-language controls retain their translations; new controls fall back to English for the other five locales.

## Configure your own TURN

Open Settings → Connection. Enter up to four `turn:host:port` or `turns:host:port?transport=tcp` URLs, an issued username and credential, and the remaining validity in minutes (1–1440). Use temporary client credentials, never the server's shared signing secret. Test and Enable must obtain a relay candidate before the app uses this configuration. Re-enter credentials after restarting the app. Disable clears them from the running configuration and affects new connections.

For an already configured coturn REST authentication service, an operator can run `node scripts/turn-credentials.mjs 60 client-label` with `KONOFIX_TURN_SHARED_SECRET` supplied securely in the operator environment. This emits one 60-minute client credential. It neither installs nor configures the server. Server ports, TLS and relay port reachability remain the operator's responsibility.

## Manual installation and update signing

This candidate is a standalone NSIS installer. Close Konofix before running it and follow the installer. Stable installers remain available at <https://github.com/Swir/Konofix/releases>. Do not publish this candidate into the stable update feed.

The public key accompanying the available local private key does not match the public key embedded in stable 0.6.0. The matching private key has not been located, and repository signing secrets are currently absent. `node scripts/check-updater-key.mjs <public-key-file>` verifies compatibility without reading or displaying a private key. Keep the existing embedded public key and signature checks intact. A future key migration would require an explicit manual-install migration plan; this candidate does not attempt it.

## External prerequisites before stable promotion

1. Test this exact installer on two physical PCs, including home Wi-Fi and LTE/CGNAT, using actual TURN credentials. Include voice + file together, device changes, cancellation, receiver/sender reconnect, old/new peer compatibility, and an hour-long soak.
2. Configure a TURN provider or a separately operated coturn host. `scripts/turn-credentials.mjs` can issue a short-lived coturn REST credential from an operator environment variable; keep the shared server secret off clients. No promise of universal NAT traversal is made.
3. Configure the existing release signing key and password in the repository's `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secrets. Verify its public key matches the client before upload. The existing stable-only publication workflow must continue to verify signatures and publish immutable updater assets.
4. Windows Authenticode needs an owner-provided valid code-signing certificate/hardware-backed signing service. An updater signature is not an Authenticode signature. No certificate purchase or self-signed substitution is made by this change.

The production account/profile should be backed up before any candidate is installed for a real session. Testing the release is separate from merging or publishing it.
