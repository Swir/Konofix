# Experimental public cold-start desktop integration

Status: experimental opt-in. Public beta publication remains HELD. The original
physical LAN-to-LTE WAN FAIL in #165 remains open. A single read-only public Amino
trial on #177 head `b398bf941bad1e1f8b75ab0a61dd33ed2d0e003c` ended without an
authenticated connection or successful RPC. Its complete, non-overwritten record
is [attempt 1](evidence/amino/amino-public-20261007-attempt1.json), SHA-256
`b5205b394c900351a1fbf8854dabb010b7e94854fef7e5b696c8073a15253670`.
The trace cannot distinguish pending DNS, dial or network-access failure.
No public interoperability PASS or qualified new Windows handoff is asserted.

## Session choices

The ordinary libp2p stack and zero-configuration LAN mDNS remain active. Expand
**Optional public discovery and relay** on the login screen to choose, separately:

- experimental public WORLD discovery for this session; off by default;
- consent to host a bounded participant relay when current public reachability
  has been demonstrated; off by default, independent of the first checkbox.

Consent is not silently persisted. Disconnect destroys the session and withdraws
relay service; reconnect requires the chosen session setting. The current UI keeps
checkbox choices while editing the same login view; a fresh application starts off.
KNP remains an optional, separate contact/identity path, never an automatic fallback
for a libp2p recipient. No account, central message history or message server is added.

The public adapter uses the same libp2p identity on an isolated Amino client swarm.
Only after a Noise/QUIC authenticated response passes the signed-ad policy does
its contact enter native direct-first routing. The existing dial planner tries
direct endpoints before bounded circuit alternatives. Native AutoNAT, UPnP and
DCUtR continue running. Unrelated Amino/AutoNAT peers are not imported into the
native DHT by Identify, and are not room-membership authorities or authorized relays.
WORLD retains public signed GossipSub semantics, not private recipient-only E2E.

## Reachability and voluntary relay

An observed Identify address is only a candidate. The adapter can ask at most eight
peers advertising the AutoNAT protocol to probe bounded native listen-port candidates.
The application correlates a successful response with a recent authenticated,
non-relayed native inbound connection from that exact server and matching transport
port. Either event order is accepted within 30 seconds. Only those individually witnessed endpoints can be published or signed in ads;
other native external-address hints are excluded. A response alone, a wrong
port/identity, an old generation or an expired witness cannot enable publication or
relay. Conservative port matching can reject mappings that change external ports;
this limitation must not be reported as proof that the host is unreachable.

The relay requires explicit consent plus reachability refreshed within five minutes.
Limits: eight reservations, one per peer, two circuits total, one per peer,
120-second reservation/circuit lifetime, 8 MiB per circuit and eight new circuits
per minute globally, with additional peer/IP rates. Desktop connection admission
is capped at 128 established, 64 incoming, four per peer and 16 pending each direction.
These are ceilings, not performance guarantees or full Sybil resistance.
Loss of reachability/interface change disables new reservations immediately and
closes connections to recorded relay participants so existing circuits cannot keep
running under withdrawn reachability. This may reconnect an associated chat peer;
no chat identity or authorization is substituted. The optional operator Node's
independent limits are unchanged.

## Recovery, privacy and honest status

Network change invalidates signed contacts, pending challenges, witness state and
relay reachability; the adapter drops its old sockets/resolver, while preserving
identity, replay tombstones and global dial budget. Native listener recovery,
DHT bootstrap, WORLD presence, mDNS and bounded reconnect remain in their existing
session loop. Expired discovery addresses are removed from native lookup/request
address stores and from pending direct-first plans. An established authenticated
native conversation is not reclassified as delivered merely because discovery worked.

Network details distinguish discovery off/searching/unavailable/no verified peer/
verified contact, and whether the local relay is currently permitted. Established
direct/circuit routes are still shown separately. Neither a verified advertisement,
a relay reservation, a peer count nor a passing local test proves a WORLD message
was delivered to another physical installation. Discovery status events are bound
to the current UI peer identity; stale session updates are ignored.

Public DHT metadata includes IP, PeerID, WORLD namespace interest and timing.
Signed ads expire locally after five minutes, but public provider records can remain
48 hours; observers can retain metadata longer. No promises of anonymity, remote
erasure, public-bootstrap SLA or independent operator diversity are made.

## Qualification still required

1. Green exact-head and post-merge Windows/Linux/security gates and preserved KNP,
   native LAN, private control, file and lifecycle regressions.
2. Diagnose the first public trial's DNS/dial boundary before another explicitly
   authorized external attempt. No repeated-until-green test and no default public
   rollout from the current failed interoperability record.
3. On a qualified exact-build installer, two clean physical PCs on different
   operators opt into the experiment, start without pasted contacts, meet in WORLD,
   exchange unique markers both directions, record actual direct/circuit routes,
   and recover after Wi-Fi/LTE switching. Append every attempt; retain #165 FAIL.

No operator-owned VPS is mandated. LAN uses mDNS; Internet cold start uses a shared
public overlay and rotating consenting participants. Discovery alone cannot connect
two fresh restrictive-CGNAT peers if no reachable compatible participant can provide
a rendezvous/relay path. Public IPFS bootstrappers are not substitute Konofix relays.

## Additional review findings

The locked libp2p-relay 0.22 checks the existing per-peer reservation/circuit count
with `>` before accepting a new request. The desktop configuration uses zero for
those two fields to enforce one effective slot. A real three-swarm loopback test
creates two connections with the same authenticated client identity, proves the
first reservation succeeds and the second is denied by the production policy.
This version-specific workaround must be rechecked when updating libp2p; the first
reservation acceptance assertion prevents silently changing the policy to deny all.

Future explicitly authorized probe attempts include bounded counters separating
DNS input, candidates reaching the resolved-address filter, policy/budget rejection
and accepted underlying-transport dial calls. These contain no endpoint or user
identity values. The original attempt JSON is unchanged: those counters were not
available then, and no retrospective DNS/failure cause is invented. A dial call
counter is not a completed socket, handshake, RPC or WAN proof.


The desktop regression suite also runs an opt-in discovery session alongside an
ordinary mDNS-only session, exchanges WORLD messages both directions and checks
that local consent without a public witness cannot enable the relay. Its discovery
transport is seedless and local-only under `cfg(test)`, including after recovery;
this is not a physical LAN/WAN result. The normal Windows regression suite remains
a required gate, alongside the shared Node/component tests.

This draft includes the same unchanged-deadline CI ordering correction as #178;
it must be reviewed and integrated after the prerequisite policy/runtime/CI PRs.


## Protocol basis and limits of the public service

The namespace-to-SHA256-multihash scheme follows libp2p's maintained
[RoutingDiscovery implementation](https://github.com/libp2p/go-libp2p/blob/v0.49.0/p2p/discovery/routing/routing.go),
which uses provider routing for service discovery. It does not establish an SLA or
operator approval for a large rollout. The [Amino specification](https://specs.ipfs.tech/routing/kad-dht/)
defines the wire protocol and record retention; [public utilities](https://docs.ipfs.tech/concepts/public-utilities/)
are explicitly best effort. The listed bootstrap names are published by IPFS, but
the failed local trial does not establish their reachability from this environment.
No new dependency or third-party source copy is introduced by this experiment.


## Connection-admission regression

Windows run 37659096461 on head `89fd7a4dfe42e86c031a016460f28f967179f32a`
passed the new mDNS/discovery coexistence test but failed the existing many-peer
rooms regression in libp2p-request-response's connection-count assertion.
The composed behavior declared its connection limiter after request/response,
which had already registered a handler before the later sibling rejected it.
Admission now comes first in both native and isolated behavior declarations;
limits and upstream assertions are unchanged. A real loopback Noise regression
opens one connection, rejects a second from the same PeerID, then closes the first.
It reproduces the identical assertion with the old order and passes with admission
first. This preserves the original failed Windows run instead of retrying it away.
