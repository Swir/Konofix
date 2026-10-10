# Public WORLD relay fallback

## Purpose and status

The primary Konofix network is still direct-first rust-libp2p. LAN mDNS, Amino
cold-start hints, Kademlia, UPnP, AutoNAT, DCUtR and consenting participant circuit
relays continue to run unchanged. Two fresh clients behind restrictive NAT/CGNAT can
nevertheless be unable to publish a dialable address or reserve a compatible public
libp2p relay. In that state, both clients can search forever without appearing in
WORLD.

The WORLD relay fallback provides automatic public presence and public WORLD text
without requiring a Konofix-owned VPS. It is enabled by the existing visible public
discovery session checkbox. A live two-client implementation probe has demonstrated
mutual presence and one deduplicated message through the configured public relays.
That probe is not the required physical two-PC independent-network acceptance test;
the previous LAN-to-LTE result remains FAIL until an exact new installer passes.

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
- event types: `presence`, `chat`, `goodbye`
- presence heartbeat / local expiry: 30 / 75 seconds
- chat validity and reconnect queue: 120 seconds
- maximum chat text: 4,000 characters
- maximum content: 12 KiB
- reconnect queue: at most 32 chat events
- replay/deduplication window: at most 2,048 event IDs

Each installation creates a persistent local Nostr signing key. Every received event
must have a valid Nostr signature, the exact kind/tag/namespace, bounded fields and a
fresh timestamp. Repeated delivery of the same event through several relays is
accepted once.

Relay participants use `nostr:<public-key>` identities in the local UI. The envelope
also carries the sender's current native libp2p PeerID as a convenience hint so a
later native connection can replace a duplicate relay-only presence entry. That
claim is not cryptographic proof of a native PeerID and is never passed to native
authorization, file transfer, protected-room or private-message code.

## Scope and privacy

The fallback carries only WORLD presence and public WORLD text. It does not carry:

- private 1:1 messages;
- temporary-room announcements, membership or passwords;
- public file offers, file bytes or image previews;
- KNP contacts or NodeIDs;
- native bootstrap or relay authorization.

WSS encrypts the connection to each relay, and Nostr signatures authenticate the
event key, but WORLD is public. Relay operators can read, copy, retain or correlate
WORLD text, IP addresses, Nostr keys, claimed PeerIDs and timing even though events
are marked ephemeral and include expiration tags. Users who do not accept this can
clear the public discovery checkbox and retain LAN/configured-peer P2P only.

## Verification

Deterministic coverage uses an in-memory four-relay model:

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
