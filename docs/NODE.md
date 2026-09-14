# Konofix Node 0.4.2

`konofix-node` jest lekkim węzłem infrastruktury społecznościowej. Nie jest serwerem kont ani bazą historii czatu.

## Funkcje

- Kademlia DHT server
- bootstrap peer
- AutoNAT peer
- Circuit Relay v2 server
- GossipSub router dla `#WORLD`
- TCP + QUIC
- stały Peer ID pomiędzy restartami
- automatyczne generowanie gotowych publicznych multiaddr

## Windows

Uruchom `build-node.bat`, a następnie:

```powershell
src-tauri\target\release\konofix-node.exe --port 45555 --public-host TWOJ_PUBLICZNY_IP
```

Możesz podać też publiczną nazwę DNS:

```powershell
konofix-node.exe --port 45555 --public-host node.example.com
```

Otwórz/przekieruj w routerze i firewallu:

- TCP 45555
- UDP 45555

Nie zmieniaj pliku `%LOCALAPPDATA%\Konofix Chat\node-identity.key`, jeśli adres bootstrap ma pozostać stabilny. Usunięcie go wygeneruje nowy Peer ID.

## Gotowy adres bootstrap

Jeśli podasz `--public-host`, Node wypisze m.in.:

```text
BOOTSTRAP TCP : /ip4/203.0.113.10/tcp/45555/p2p/12D3KooW...
BOOTSTRAP QUIC: /ip4/203.0.113.10/udp/45555/quic-v1/p2p/12D3KooW...
REKOMENDOWANY : /ip4/203.0.113.10/tcp/45555/p2p/12D3KooW...
```

Adres `REKOMENDOWANY` wklejamy w aplikacji: **Ustawienia sieci → Bootstrap**. Klient zapamięta go lokalnie.

Adresy `0.0.0.0`, `127.0.0.1`, `::` i prywatne `192.168.x.x` nie są globalnymi adresami bootstrap. Potrzebny jest publiczny IP/DNS oraz osiągalny port.

## VPS

Na VPS wystarczy jeden mały proces Node. Z czasem uruchomimy kilka niezależnych node w różnych krajach/operatorach, aby awaria jednego nie odcinała całej sieci.

## Prywatność

Node nie zapisuje historii czatu ani plików. Transfer plików używa request/response między peerami i może przejść przez szyfrowany transport relay, jeśli bezpośrednie połączenie jest niemożliwe. `#WORLD` jest publicznym tematem GossipSub.
