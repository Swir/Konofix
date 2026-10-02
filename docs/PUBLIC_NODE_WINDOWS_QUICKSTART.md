# Konofix public Node — Windows quick start

Use this path when the bootstrap/relay host is Windows or Windows Server.

## Requirements

- a Windows machine that can be reached from the public Internet,
- inbound TCP **and** UDP port 45555,
- Administrator rights,
- the exact Konofix Windows bundle containing `konofix-node.exe` and the bundled scripts.

A Windows VPS with a public IP is the simplest case. A home PC can work when the router forwards TCP+UDP 45555 to that PC. CGNAT can prevent inbound reachability even when Windows Firewall is configured correctly.

## One-click assisted setup

Run:

```text
START-GLOBAL-NODE.cmd
```

The helper:

1. elevates to Administrator,
2. asks for the public IP/DNS name,
3. previews the exact Scheduled Task/firewall plan,
4. requires the literal confirmation `INSTALL`,
5. installs the protected persistent Node service,
6. starts it and keeps its identity in `%ProgramData%\KonofixNode`.

Never publish or delete `node-identity.key`. Its Peer ID is the stable identity used by the bootstrap pool.

## Qualification

Installing the task is not enough. From another Internet connection verify:

- TCP 45555 reachability,
- UDP/QUIC libp2p handshake using `konofix-netprobe.exe`,
- health snapshot version/source commit,
- stable Peer ID after restart.

Only after those checks pass should the exact bootstrap address be added to the canonical client pool.
