# Public WORLD relay fallback

## Purpose and status

The primary Konofix network is still direct-first rust-libp2p. LAN mDNS, Amino
cold-start hints, Kademlia, UPnP, AutoNAT, DCUtR and consenting participant circuit
relays continue to run unchanged. Two fresh clients behind restrictive NAT/CGNAT can
nevertheless be unable to publish a dialable address or reserve a compatible public
libp2p relay. In that state, both clients can search forever without appearing in
WORLD.

The WORLD relay fallback provides automatic public presence and public WORLD text
without requiring a Konofix-owned VPS. Version 0.5.3 also carries recipient-addressed
NIP-44 encrypted private text and an explicit small-file fallback when the two native
libp2p peers cannot form a route. It is enabled by the existing visible public
discovery session checkbox. The exact 0.5.2 build passed physical two-PC WORLD text;
the new encrypted private/file paths remain candidate functionality until the same
physical topology validates an exact 0.5.3 installer.

## Replaceable public relays

The candidate uses four WSS Nostr relays:

- `wss://relay.damus.io`
- `wss://nos.lol`
- `wss://relay.primal.net`
- `wss://nostr.mom`

All four accepted and delivered a random NIP-01 ephemeral test event during the
bounded 2026-10-10 probe. They are independent third-party services, not Konofix
infrastructure, and provide no availability guarantee. The client reconnects with
bounded exponential backoff; one relay is sufficient for live WORLD text while
multiple relays reduce dependence on any single operator.

## Wire and identity contract

- NIP-01 ephemeral event kind: `28733`
- subscription tag: `t = konofix-world-v1`
- application namespace: `konofix/world-relay/1`
- public event types: `presence`, `chat`, `goodbye`
- encrypted event types: `private`, `file_offer`, `file_accept`, `file_reject`, `file_chunk`, `file_chunks_complete`, `file_missing`, `file_saved`
- presence heartbeat / local expiry: 30 / 75 seconds
- chat validity and reconnect queue: 120 seconds
- maximum chat text: 4,000 characters
- maximum public content: 12 KiB
- maximum encrypted file: 2 MiB, divided into 16 KiB plaintext chunks
- reconnect queue: at most 512 short-lived public/encrypted events; an explicit
  completion/missing-index exchange retries lost file chunks for at most three rounds
- replay/deduplication window: at most 2,048 event IDs

Each installation creates a persistent local Nostr signing key. Every received event
must have a valid Nostr signature, the exact kind/tag/namespace, bounded fields and a
fresh timestamp. Repeated delivery of the same event through several relays is
accepted once.

Relay participants use `nostr:<public-key>` identities in the local UI. The envelope
also carries the sender's current native libp2p PeerID as a convenience hint so a
later native connection can replace a duplicate relay-only presence entry. That
claim is not cryptographic proof of a native PeerID and is never passed to native
authorization, protected-room or native request/response code. Relay-only private
messages and small files bind to the independently signed `nostr:<public-key>`
identity instead.

## Scope and privacy

The fallback carries WORLD presence/public text plus recipient-addressed encrypted
private text and accepted encrypted files up to 2 MiB. It does not carry:

- temporary-room announcements, membership or passwords;
- public room file offers or image previews;
- KNP contacts or NodeIDs;
- native bootstrap or relay authorization.

WSS encrypts each relay connection, Nostr signatures authenticate the event key, and
NIP-44 encrypts private text and file envelopes end to end to the recipient relay
key. WORLD remains public. Relay operators can read/copy WORLD text and can retain or
correlate ciphertext, IP addresses, Nostr keys, claimed PeerIDs, sizes and timing even
though events are marked ephemeral and include expiration tags. Receiver-side Rust
code independently verifies file size and SHA-256 before an exclusive no-clobber
save to `Downloads/Konofix Chat`. Users who do not accept relay metadata exposure can
clear the public discovery checkbox and retain LAN/configured-peer P2P only.

## Verification

Deterministic coverage uses an in-memory four-relay model, including NIP-44 private
delivery and a multi-chunk encrypted file with saved acknowledgement:

```text
npm run test:world-relay
```

The bounded public probe verifies write acknowledgement and subscriber delivery on
each configured relay:

```text
node scripts/probe-world-relays.mjs
```

The exact browser bridge can also be run as two independent clients against the
public relay set:

```text
node --experimental-strip-types scripts/test-world-relay-live.mjs
```

These checks validate implementation and public relay interoperability. They do not
claim a physical Windows installer, independent-network, long-soak or failover PASS.
