# Konofix Node 0.4.2

`konofix-node` is a lightweight community infrastructure node. It is not an account server and it does not store chat history.

## Features

- Kademlia DHT server
- bootstrap peer
- AutoNAT peer
- Circuit Relay v2 server
- GossipSub router for `#WORLD`
- TCP + QUIC
- persistent Peer ID across restarts
- automatic generation of ready-to-use public multiaddresses
- periodic operational status lines with uptime and connected-peer count
- IPv4, IPv6, and generic DNS bootstrap address generation

## Windows

Run `build-node.bat`, then start:

```powershell
src-tauri\target\release\konofix-node.exe --port 45555 --public-host YOUR_PUBLIC_IP
```

A public DNS name is also supported:

```powershell
konofix-node.exe --port 45555 --public-host node.example.com
```

The default status interval is 60 seconds. It can be changed to any value of 10 seconds or more:

```powershell
konofix-node.exe --port 45555 --public-host node.example.com --status-interval 30
```

Status output is intentionally metadata-only:

```text
STATUS uptime=3600s connected_peers=8 peer_id=12D3KooW...
```

It does not include chat messages, room contents, filenames, or transferred data.

Open/forward these ports in the router and firewall:

- TCP 45555
- UDP 45555

Do not replace or delete `%LOCALAPPDATA%\Konofix Chat\node-identity.key` if the bootstrap address should remain stable. Deleting the file generates a new Peer ID.

## Ready bootstrap address

When `--public-host` is provided, the Node prints entries such as:

```text
BOOTSTRAP TCP : /ip4/203.0.113.10/tcp/45555/p2p/12D3KooW...
BOOTSTRAP QUIC: /ip4/203.0.113.10/udp/45555/quic-v1/p2p/12D3KooW...
RECOMMENDED   : /ip4/203.0.113.10/tcp/45555/p2p/12D3KooW...
```

For DNS names, the Node uses the generic `/dns/...` multiaddr form so the hostname is not artificially restricted to IPv4-only resolution.

Paste the `RECOMMENDED` address into **Network settings → Bootstrap**. The client stores it locally.

Addresses such as `0.0.0.0`, `127.0.0.1`, `::`, private IPv4 addresses, and IPv6 unique-local/link-local addresses are not global bootstrap addresses. The Node prints a warning when `--public-host` is an obviously non-public IP literal.

A public IP or DNS name plus reachable TCP and UDP ports are required for a proper Internet test.

## VPS

A small VPS only needs one Konofix Node process. The long-term goal is to run several independent nodes across different countries and providers so one outage cannot disconnect the entire network.

For a public test node, keep the process supervised by the operating system or a service manager, preserve the identity file, monitor the periodic status line, and verify both TCP and UDP/QUIC reachability from an external network.

## Privacy

The Node does not save chat history or files. File transfer uses request/response between peers and can traverse an encrypted relay transport when direct connectivity is impossible. `#WORLD` is a public GossipSub topic.
