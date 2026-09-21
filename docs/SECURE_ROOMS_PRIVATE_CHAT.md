# Secure rooms and private chat — frozen package design

Status: implementation foundation for the user-approved KonOFIX feature freeze extension. This document does not claim either capability is complete or released.

## Goals

The frozen package adds exactly two capabilities without widening scope:

1. optional password protection for temporary Rooms 2.0 rooms;
2. authenticated private user-to-user text chat.

The existing Beta 1 chat, emoji, nickname colors, public file/image offers, direct file transfer, membership runtime, installer, evidence tooling and release provenance remain compatibility constraints.

## Transport boundary

Passwords and private messages must never be placed on `konofix/world/v3` GossipSub. They use a dedicated authenticated request/response protocol:

`/konofix/control/1.0.0`

The transport is carried over the existing libp2p authenticated/encrypted connection. Request and response codecs are bounded. Unknown/older peers fail closed: an unsupported private message or protected-room join produces a normal request failure and must not fall back to public GossipSub.

## Protected rooms

Public room metadata exposes only that a room is locked plus a monotonic authorization revision. It never includes a password, verifier, salt or password-derived material.

The room owner keeps a process-local password verifier. The verifier uses PBKDF2-HMAC-SHA256 with a random per-room 128-bit salt and a bounded work factor. The password itself is used only while creating/changing the verifier or while it is carried inside the direct encrypted room-join request; it is not persisted by Konofix and its debug representation is redacted.

A successful direct password check creates a bounded access grant containing only:

- room ID;
- owner PeerId;
- granted PeerId;
- authorization revision;
- expiry time.

The grant is authenticated by the owner identity. Membership and room-chat acceptance must require a valid current grant for locked rooms. Changing or removing a password increments the authorization revision and invalidates old grants. Stale revisions and mismatched owner/grantee identities fail closed.

Room-password attempts are rate limited per peer/room and the limiter is bounded/periodically pruned. The owner remains authorized without entering its own password.

## Private 1:1 chat

A private message is a direct control request addressed to one PeerId and contains:

- UUID message ID;
- authenticated sender PeerId;
- target PeerId;
- current nickname and approved nickname color;
- bounded text payload;
- timestamp.

Acceptance requires the request's authenticated libp2p source to match the claimed sender, the target to match the local PeerId, the presence identity to match when available, the timestamp to be fresh, the message ID not to be a replay, and the per-peer rate limit to allow the message.

Private messages are never represented as a public `WireEvent::Chat` and never use a room GossipSub topic. UI conversations remain visually separate from `#WORLD` and Rooms 2.0. Existing safe emoji/text rendering is reused.

## Compatibility policy

- Old room announcements without lock metadata are interpreted as unlocked rooms.
- New protected rooms never downgrade to unlocked operation merely because a peer lacks the control protocol.
- Older peers cannot obtain a protected-room grant; new peers reject their unauthorized membership/chat claims for that protected room.
- Private messaging to a peer that does not support `/konofix/control/1.0.0` fails explicitly and never leaks the message to `#WORLD`.

## Verification gates before merge

The implementation PR must prove at minimum:

- password validation bounds and redacted diagnostics;
- PBKDF2-HMAC-SHA256 test vectors;
- successful and rejected room authorization;
- grant owner/grantee/revision/expiry binding;
- bounded wrong-password retries;
- password change/removal revokes stale authorization;
- unauthorized/stale/replayed protected-room state is rejected;
- private sender/target identity binding;
- private stale/oversize/replayed/rate-limited messages are rejected;
- private messages have no GossipSub fallback;
- UI lock state, password join flow, separate private conversations and unread state;
- all seven locales include the new user-visible strings with English fallback;
- exact-head Windows CI, Linux Node CI and RustSec are green before merge.

No release publication is part of this package. After the complete six-capability frozen package is green on `main`, development stops for user-led pre-publication testing.
