# Konofix public Node — fastest Debian VPS path

This is the shortest controlled path to restore automatic Internet discovery for fresh Konofix clients. A domain is optional; a globally routable public IPv4 or IPv6 address is enough.

## 1. Use the exact Linux Node artifact

Download the `Konofix-Node-0.6.0-Linux-x86_64-<FULL_SHA>` artifact from the same exact-head Linux Node CI run as the Windows candidate. Do not mix a Node from another source commit with the client being qualified.

Extract it on the VPS and verify the archive checksum supplied by CI.

## 2. Install the persistent service

From the extracted bundle:

```bash
chmod +x ./konofix-node ./scripts/install-public-node-linux.sh
sudo ./scripts/install-public-node-linux.sh \
  --public-host YOUR_PUBLIC_IP \
  --binary ./konofix-node \
  --install \
  --start-now
```

The installer stages an unprivileged systemd service and keeps the identity under `/var/lib/konofix-node`. Do not delete `node-identity.key`: the Peer ID derived from that file is the stable bootstrap identity shipped to clients.

## 3. Allow both transports

Konofix needs the same public port for TCP and UDP/QUIC:

```bash
sudo ufw allow 45555/tcp
sudo ufw allow 45555/udp
```

If the VPS provider has a separate firewall/security-group panel, allow inbound TCP **and** UDP 45555 there as well. Opening only TCP is not full qualification.

## 4. Read the exact bootstrap identity

```bash
sudo journalctl -u konofix-node -n 100 --no-pager
sudo cat /var/lib/konofix-node/node-health.json
```

The Node log prints the ready TCP and QUIC multiaddresses. Keep the full `/p2p/<PEER_ID>` suffix.

## 5. External qualification

Before adding the address to the default pool:

- validate that the public IP is globally routable,
- prove TCP reachability from another network,
- prove a real Konofix QUIC/libp2p handshake from another network,
- verify the health snapshot contains the expected exact source commit and stable Peer ID,
- restart the service and confirm the Peer ID is unchanged.

A successful local VPS socket/listener test alone is not Internet evidence.

## 6. Client pool

For the controlled 0.6 Beta, one verified Node can be used temporarily with a documented single-point-of-failure limitation. Before Global Beta resilience is claimed, add at least a second independent Node/identity and prove failover.

Konofix Nodes are discovery/relay infrastructure. They do not store chat history or files.
