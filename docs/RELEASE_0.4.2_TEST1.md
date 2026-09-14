# Konofix Chat 0.4.2 Test 1 — Cross-country P2P Preview

This is the **first Konofix Chat test release** intended for validating P2P communication over the Internet between independent networks and different countries.

## Included

- Konofix Chat for Windows,
- `konofix-node.exe` — bootstrap / Kademlia DHT / Circuit Relay,
- TCP + QUIC,
- AutoNAT + DCUtR,
- global `#WORLD`,
- temporary rooms,
- distributed nickname reservation,
- P2P file transfer with recipient approval, 256 KiB chunks, and SHA-256 verification,
- local cache of discovered peers,
- cross-country testing instructions.

## Simplest Internet test

1. Run `konofix-node.exe` on a computer/VPS with a public IP.
2. Open TCP and UDP `45555`.
3. Start:

```powershell
konofix-node.exe --port 45555 --public-host YOUR_PUBLIC_IP_OR_DNS
```

4. Copy the printed `BOOTSTRAP TCP` address.
5. On two computers in different networks/countries, add the same bootstrap in **Network settings → Bootstrap**.
6. Test `#WORLD`, a temporary room, and file transfer in both directions.

The full matrix is documented in `docs/TESTING.md`.

## Important limitations

- This is a **pre-release**, not the final public version.
- There is no built-in public community-bootstrap pool yet; testers may run their own Konofix Node.
- `#WORLD` is a public distributed channel. libp2p transport is encrypted, but the public room is not a private E2E conversation.
- Private P2P/E2E conversations are planned for a later roadmap stage.
- Windows may show a SmartScreen warning because this test build is not yet signed with a commercial code-signing certificate.

## What we want to confirm

Primary scenario:

**client behind NAT/CGNAT in country A ↔ public Konofix Node ↔ client behind a different NAT/CGNAT in country B**

We test:

- TCP,
- QUIC,
- DHT discovery,
- Circuit Relay,
- DCUtR / hole punching,
- peer reconnect/cache,
- nickname reservation,
- chat,
- rooms,
- file transfer and SHA-256 verification.

## Reporting a bug

Include the version, country/network type of both clients, bootstrap used, chat/room/file/reconnect result, and when the failure happened.

Never publish the private `node-identity.key` file or any other secret.

---

**Konofix Chat — by Swir**
