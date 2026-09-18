# Nickname lease security

Konofix uses GossipSub for live presence and Kademlia as a fallback lookup for short-lived distributed nickname leases. A nickname lease is authoritative only when its application payload is authenticated by the libp2p identity that owns the claimed Peer ID.

## Trust boundary

Each lease signs a domain-separated payload containing the claimed Peer ID, display nickname, canonical nickname and expiration. The signed envelope uses the same libp2p identity key as the network session. Receivers verify the envelope signature, recover its signing key and require that key to derive the claimed Peer ID before a lease can participate in deterministic conflict resolution.

DHT records additionally must use the exact `/konofix/nick/<canonical>` key. If a Kademlia publisher field is present it must match the authenticated lease identity, but publisher metadata alone is never treated as proof. Expired leases, leases beyond the 42-second lifetime plus the explicit 5-second clock-skew allowance, malformed nicknames, canonical mismatches, oversized envelopes and unsigned legacy records are non-authoritative and cannot trigger `nick-conflict`.

GossipSub `NickClaim` events carry the same signed lease envelope and remain separately bound to the authenticated GossipSub source Peer ID. Presence remains a live source-authenticated signal; the DHT fallback cannot override identity checks.

This is protocol hardening, not Real Internet Test evidence, and therefore does not change the active milestone counter.
