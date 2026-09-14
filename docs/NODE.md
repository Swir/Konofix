# Konofix Node 0.4.1

`konofix-node` jest lekkim węzłem infrastruktury społecznościowej. Nie jest serwerem kont ani bazą historii czatu.

## Funkcje

- Kademlia DHT server
- bootstrap peer
- AutoNAT peer
- Circuit Relay v2 server
- GossipSub router dla `#WORLD`
- TCP + QUIC
- stały Peer ID pomiędzy restartami

## Windows

Uruchom `build-node.bat`, a następnie:

```powershell
src-tauri\\target\\release\\konofix-node.exe --port 45555
```

Otwórz/przekieruj w routerze i firewallu:

- TCP 45555
- UDP 45555

Nie zmieniaj pliku `%LOCALAPPDATA%\\Konofix Chat\\node-identity.key`, jeśli adres bootstrap ma pozostać stabilny. Usunięcie go wygeneruje nowy Peer ID.

## Adres bootstrap

Po uruchomieniu Node wypisuje `LISTEN:`. Do aplikacji kopiujemy pełny publiczny adres kończący się `/p2p/<PeerId>`.

Adresy `0.0.0.0`, `127.0.0.1`, `::` i prywatne `192.168.x.x` nie są globalnym adresem bootstrap. Do publicznego wpisu potrzebny jest publiczny IP lub publiczna nazwa DNS.

## VPS

Na VPS wystarczy jeden mały proces Node. Z czasem można uruchomić kilka niezależnych node w różnych krajach/operatorach. Dzięki temu awaria jednego nie wyłącza całej sieci.

## Prywatność

Node nie zapisuje historii czatu ani plików. Transfer plików używa request/response między peerami i może przejść przez zaszyfrowany transport relay, jeśli bezpośrednie połączenie jest niemożliwe. `#WORLD` jest publicznym tematem GossipSub; E2E dla treści publicznego kanału nie jest jeszcze częścią 0.4.0.
