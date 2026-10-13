# Konofix Chat 0.6.0 — Stable chat, large files and voice

Konofix Chat 0.6.0 brings the owner-approved chat feature line to a stable Windows release: public WORLD messaging, private conversations, shared files and voice without a mandatory Konofix-owned account server or VPS.

## Included features

- Automatic LAN discovery and public-relay-assisted Internet WORLD presence/text; choose a nickname and connect.
- Public WORLD and temporary public rooms, private messages, room member lists, nickname colors and emoji. Password-protected rooms remain on the authenticated native network.
- One file picker for documents and images. Native/WebRTC streaming supports files up to 32 GiB; PNG, JPEG, GIF and WebP images up to 8 MiB can be explicitly previewed. Public cards advertise metadata only; file bytes are downloaded on request and checked against size/SHA-256.
- Private calls with recipient acceptance, incoming ringtone, outgoing ringback, mute and hangup.
- WORLD voice with one speaker for up to 60 seconds, visible queue and early handoff; simultaneous group voice in public user-created rooms.
- WORLD-only listening mute, speaker test and microphone test/meter.
- Seven application languages selected automatically at startup: English, Polish, Norwegian, German, French, Spanish and Ukrainian.
- Optional Windows/Linux headless Node, Netprobe diagnostics and a separately scoped KonoNexus/KNP contact-text panel.

The [user guide](USER_GUIDE.md) explains how each feature works, where files are stored, permissions and troubleshooting.

## Reliability fixes

- Private voice uses a native media element rather than depending on the ringtone audio graph.
- Repeated or concurrent signaling answers apply only once, fixing the reported `setRemoteDescription` / `wrong state: stable` error.
- Hangup cancels pending negotiations and playback callbacks; late network messages cannot revive ended audio.
- File-transfer errors and file-only hangups no longer silence a separate private call with the same person.
- Shared microphone ownership, bounded Windows device retries, gathered ICE, signaling retries and WORLD queue recovery remain in place.

## Installation and updates

Download the 0.6.0 Windows setup file from this release, verify its published SHA-256, close the old application, and install. Use the same version on both computers. The desktop shortcut launches **Konofix Chat**; Node and Netprobe are optional command-line tools.

The program contains signed, stable-only update support with user confirmation before download/install. **This release is installed manually: signing credentials for the automatic update feed are not configured, and no unsigned `latest.json` is published.** Updater signing and Microsoft Authenticode are different systems; the Windows installer is not Authenticode-signed.

## Network and privacy limits

There is no mandatory Konofix-owned server, but automatic Internet operation uses replaceable third-party Nostr relays, public DHT bootstrap infrastructure and STUN. It is not an infrastructure-free system. Public WORLD/room text, room names, public file metadata and voice-queue state are public; relay operators can observe and retain them. Private relay text and WebRTC setup use NIP-44 encryption; direct WebRTC file/audio transport is encrypted.

**No working TURN fallback is configured.** STUN-only direct audio/large-file connections can fail with restrictive NAT/CGNAT/firewalls even while WORLD text and private relay text work. The 32 GiB limit is a supported protocol limit, not a claim that every file size or every network pair was physically tested. A sender must stay online while offering/transferring a file; public offers expire after ten minutes. The legacy encrypted relay-file route retains its separate 2 MiB limit.

## Acceptance and scope

The owner explicitly confirmed that the identified `audio-fix-1716e8d` candidate delivers private voice on both PCs without the reported post-hangup error and requested stable publication. See the [precise acceptance record](evidence/CHAT_AUDIO_ACCEPTANCE_20261013.md).

Stable 0.6.0 is a new versioned build of that application feature line, not a renamed or byte-identical alpha installer. Its source, CI run, installer size and checksums are recorded in the release assets and `BUILD_INFO.json`.

The shipped chat implementation scope is 100% of its ten defined feature groups. This does **not** complete the independent Global Beta infrastructure/load/soak/failover qualification, which remains 56/67 (83.6%), nor promise universal connectivity or zero defects.
