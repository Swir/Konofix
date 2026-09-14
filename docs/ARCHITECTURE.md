# Konofix Chat — architektura 0.4.1

## Klient Windows

Tauri 2 + TypeScript GUI + Rust/libp2p.

`Swarm` klienta zawiera:

- TCP + QUIC
- Noise/Yamux
- GossipSub
- mDNS
- Kademlia
- Identify
- Ping
- AutoNAT
- Circuit Relay client/server
- DCUtR
- UPnP
- request-response CBOR dla plików

## Discovery

1. mDNS odnajduje LAN.
2. Cache peerów próbuje znanych adresów z poprzednich sesji.
3. Bootstrap dostarcza pierwszy globalny punkt wejścia.
4. Kademlia znajduje kolejnych providerów `#WORLD`.
5. Identify wymienia adresy słuchania.
6. Adresy są zapisywane w lokalnym cache.

## NAT / Relay

Klient próbuje TCP/QUIC bezpośrednio. AutoNAT określa osiągalność. UPnP może wystawić port. DCUtR próbuje hole punching. Gdy bezpośrednie P2P się nie uda, klient może użyć Circuit Relay.

## Konofix Node

Node ma trwały Peer ID i przewidywalny port. Pełni rolę bootstrapu DHT, AutoNAT peera i relay. Nie prowadzi bazy kont ani historii rozmów.

## Nicki

Nick jest normalizowany NFKC + lowercase. Rezerwacja korzysta z krótkiego DHT lease i `NickClaim` w `#WORLD`. Przy partycji sieci może wystąpić chwilowy konflikt; po ponownym połączeniu kontrola Peer ID wybiera jednego aktywnego właściciela.

## Pliki

Pliki nie są publikowane do GossipSub. Oferta i fragmenty idą protokołem request-response CBOR. Odbiorca zapisuje `.konofixpart`, następnie weryfikuje SHA-256 i dopiero wtedy nadaje finalną nazwę.

## Branding

Nazwa produktu: **Konofix Chat**. Autor: **Swir**. Oficjalne repo: `https://github.com/Swir/Konofix`.
