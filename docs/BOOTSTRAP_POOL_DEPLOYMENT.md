# Replaceable Internet entry peers — 0.5.2 blocker and deployment

## Current verified state

The user reported real two-PC LAN discovery followed by **WAN FAIL** after one
PC moved to LTE: users no longer met in WORLD. Original report:
[#165](https://github.com/Swir/Konofix/issues/165). Its exact tester build hash was
not supplied; do not invent a binding. LAN discovery was observed, not a complete
file/restart acceptance campaign.

At main `d14bc36d0da003e1d85e55cb004f36f53572eded`, the build-owned
`src-tauri/bootstrap-pool.json` has zero seeds. Frontend localStorage also starts
with no custom bootstrap. Retry, DHT, AutoNAT and hole punching cannot find an
unknown Internet mesh from no reachable first contact. This is a product
release blocker for the automatic WORLD requirement.

Upstream KonoNexus was refreshed at
`ea9cc5dfffa7480ab5a1bb0f79e8b5649fdeea3e`, including issue #7, the SDK, CLI and
tester. SDK seed peers default to an empty vector; the CLI accepts supplied
peers and the tester supplies no default public pool. No verified reachable
public seeds were found in those sources. KNP socket endpoints/NodeIDs are
not libp2p bootstrap multiaddresses/PeerIDs and cannot fill this pool.

No public hosts, operator access or verified endpoints are available in this
handoff. No VPS was provisioned and no external reachability check was run.
The production pool deliberately stays empty until real peers are deployed.
Code and a parser cannot complete automatic Internet WORLD by themselves.

## Deployment: three independent participants

Use `deploy/bootstrap-operators.template.json` as an operator worksheet,
not an application config or evidence of availability. Fill three rows with
real hosts, stable PeerIDs, distinct operator/failure domains and actual
external observations. No placeholder address belongs in the production pool.

1. Obtain three continuously available public Linux x86_64 hosts across
   independent providers/networks (prefer independent operators). One failed
   host/provider must leave other contacts. Each runs the same verified
   Konofix Node build with its own private persistent identity.
2. Download the exact-main Linux Node artifact and validate its checksum and
   NODE_BUILD_INFO. Follow [NODE_LINUX.md](NODE_LINUX.md); existing production
   installation tooling validates real public addresses/DNS and produces a
   hardened systemd service. On **each separate host** preview, then install:

   ```bash
   : "${KONOFIX_PUBLIC_HOST:?Set this host's actual public IP or DNS name}"
   bash scripts/install-public-node-linux.sh \
     --public-host "$KONOFIX_PUBLIC_HOST" --binary ./konofix-node \
     --require-dns-resolution
   sudo bash scripts/install-public-node-linux.sh \
     --public-host "$KONOFIX_PUBLIC_HOST" --binary ./konofix-node \
     --require-dns-resolution --install --start-now
   ```

3. Permit that host's TCP 45555 and UDP 45555 in provider and host firewalls.
   The installer does not change firewalls. Preserve its identity file; share
   only the printed public PeerID and TCP/QUIC multiaddresses.
4. From genuinely independent networks run the bundled Netprobe/readiness
   procedures against **each actual identity and transport**. Record exact
   source/hash, timestamps, operator/failure domain and results. An open TCP
   port, DNS answer or started service is not QUIC/circuit/application proof.
5. In a reviewed PR, replace the empty `seeds` array with those real TCP and
   QUIC multiaddresses ending in the verified `/p2p/<PeerID>`. Keep schema 1,
   bounded to 32 sources. Three distinct PeerIDs with two transports each use
   six entries. No new frontend localStorage setup is needed: the backend
   already loads the build-owned pool before optional user entries.
6. Build a new exact-source Windows candidate. Test a clean application profile
   on Wi-Fi/wired and LTE with **no pasted addresses**, bidirectional WORLD,
   actual direct/circuit routes, restart and network change. Stop one entry
   peer, then replace it while retaining at least two overlapping contacts.
   Preserve every failure; only the real application retest can close #165.

All clients contact the same replaceable pool; signed GossipSub subscriptions
and Kademlia share the WORLD mesh through connected participants. These nodes
provide discovery, optional relay and normal public-topic forwarding, not
accounts, central message storage or history. Public WORLD remains public.
Private control/files keep existing peer-bound authorization; a relay forwards
transport traffic without becoming the recipient identity. KNP stays optional.

## Recovery slice and honest limits

Direct listen-address additions/expiry and closed direct listeners now schedule
a debounced, rate-limited recovery pass. It recreates missing TCP/QUIC wildcard
listeners, retries disconnected configured contacts without their old backoff,
re-runs Kademlia bootstrap/provider lookup/publication and republishes presence.
Connection establishment at a configured entry also refreshes WORLD discovery.
Identity, rooms, transport choices and the primary session are not reset.

Configured relay reservations now retain listener IDs, with at most three
configured peers reserved. Closed reservations and final peer disconnection
release their slot; bounded recovery/retry may request them again. A failed
parallel dial does not mark an already connected bootstrap disconnected.
Existing separately bounded discovered-participant relays remain.

Identify already pushes listen-address updates. AutoNAT, UPnP and DCUtR remain
the existing libp2p behaviours and receive Swarm address/connection events; this
change does not manually overwrite their result or claim a successful NAT
probe, port mapping or hole punch. Recovery after an actual default-gateway
change, CGNAT and router-specific UPnP behavior still requires field evidence.
No reachable public pool means no automatic global first contact even with
this recovery logic.

The regression cycles actual listeners/connections on production swarms, with
mDNS disabled **only for that test**, then requires automatic bootstrap-based
WORLD messages both ways. The existing mDNS-only production regression keeps
empty caches and no bootstraps. These are local regressions, not LTE/WAN PASS.

UI reports configured/connected entry peers separately from total/direct/
circuit connections. An entry connection is not proof that the intended remote
user is in WORLD, and a relay reservation is not an application route.
