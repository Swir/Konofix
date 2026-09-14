# Changelog

## 0.4.1

- projekt przemianowany na **Konofix Chat**,
- autor w UI: **by Swir**,
- dodano aktywny link do `https://github.com/Swir/Konofix`,
- zmieniono namespace protokołu na `konofix`,
- zmieniono pliki tymczasowe transferu na `.konofixpart`,
- dodano Windows CI i `scripts/internet-test.ps1`,
- przygotowano projekt do realnego testu Internet ↔ Node ↔ Internet.

## 0.4.0

- dodano Circuit Relay server do klienta,
- dodano automatyczną próbę relay-listener przez bootstrap,
- dodano trwały cache adresów peerów,
- przy starcie aplikacja próbuje ponownie znane peery,
- dodano osobny `konofix-node` z Kademlia DHT, AutoNAT, Circuit Relay i GossipSub,
- Node zachowuje Peer ID w lokalnym pliku tożsamości,
- dodano `build-node.bat` i `run-node.bat`,
- rozszerzono skrypty kontrolne i build Windows,
- GUI pokazuje stan relay w panelu sieci,
- zaktualizowano dokumentację i roadmapę.

## 0.3.0

- P2P file transfer,
- Akceptuj/Odrzuć,
- 256 KiB chunks,
- SHA-256,
- `.konofixpart`,
- pasek postępu i anulowanie.
