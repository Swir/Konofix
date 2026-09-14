# Konofix Chat 0.4.2

**Konofix Chat** to efemeryczny komunikator peer-to-peer dla Windows tworzony przez **Swir**. Użytkownik uruchamia aplikację, wybiera nick, trafia do globalnego `#WORLD`, może tworzyć tymczasowe pokoje i wysyłać pliki bezpośrednio do innych użytkowników. Po wyłączeniu aplikacji użytkownik znika z sieci.

GitHub: https://github.com/Swir/Konofix

## Główne zasady

- brak klasycznego konta, e-maila i numeru telefonu,
- jeden aktywny nick w sieci; `SWIR` i `swir` są traktowane jako ten sam nick,
- globalny pokój `#WORLD`,
- pokoje tworzone przez użytkowników są tymczasowe,
- wiadomości nie są archiwizowane przez Konofix Chat,
- transfer plików P2P wymaga akceptacji odbiorcy,
- pliki lecą porcjami 256 KiB i są weryfikowane SHA-256,
- aplikacja preferuje bezpośrednie P2P, a Circuit Relay jest ścieżką awaryjną,
- poznane adresy peerów są cache'owane lokalnie,
- zamknięcie aplikacji usuwa obecność użytkownika z aktywnej sieci.

## 0.4.2 — Internet Test Ready

Ta wersja porządkuje repo i upraszcza uruchomienie pierwszego publicznego Konofix Node. Node potrafi teraz sam wygenerować gotowe multiaddr z Peer ID dla TCP i QUIC.

```powershell
konofix-node.exe --port 45555 --public-host 203.0.113.10
```

Wynik zawiera m.in.:

```text
BOOTSTRAP TCP : /ip4/203.0.113.10/tcp/45555/p2p/12D3KooW...
BOOTSTRAP QUIC: /ip4/203.0.113.10/udp/45555/quic-v1/p2p/12D3KooW...
REKOMENDOWANY : /ip4/203.0.113.10/tcp/45555/p2p/12D3KooW...
```

Adres `REKOMENDOWANY` wklejamy w **Ustawienia sieci → Bootstrap**. Bootstrap służy tylko do wejścia do DHT/relay — nie jest serwerem historii wiadomości ani magazynem plików.

## Architektura

Frontend: **Tauri 2 + TypeScript**  
Core: **Rust + Tokio + rust-libp2p**

Sieć klienta obejmuje TCP, QUIC, Noise/Yamux, GossipSub, mDNS, Kademlia DHT, Identify, Ping, AutoNAT, Circuit Relay client/server, DCUtR, UPnP i request-response CBOR dla transferu plików.

## Uruchomienie developerskie

Wymagane: Windows 11, Node.js 20+ oraz Rust MSVC.

```powershell
npm install
npm run tauri dev
```

lub `run-dev.bat`.

## Kontrola projektu

```powershell
.\scripts\check.ps1
```

GitHub wykonuje dodatkowo kontrolę na `windows-latest`: TypeScript/Vite, aplikacja Rust i `konofix-node`.

## Build Windows

```powershell
.\scripts\build-windows.ps1
```

Aplikacja trafia do `src-tauri\target\release\bundle`.

### Konofix Node

```powershell
build-node.bat
```

Wynik:

```text
src-tauri\target\release\konofix-node.exe
```

Node uruchamiamy na publicznie osiągalnym komputerze/VPS:

```powershell
konofix-node.exe --port 45555 --public-host TWOJ_PUBLICZNY_IP
```

Otwórz TCP 45555 oraz UDP 45555. Szczegóły są w `docs/NODE.md`.

Przed testem klienta:

```powershell
.\scripts\internet-test.ps1 -Bootstrap "/ip4/203.0.113.10/tcp/45555/p2p/12D3KooW..."
```

## Dane lokalne

- cache peerów: `%LOCALAPPDATA%\Konofix Chat\peer-cache.json`
- tożsamość Node: `%LOCALAPPDATA%\Konofix Chat\node-identity.key`
- pobrane pliki: `Pobrane\Konofix Chat`

## Status

`0.4.2` jest etapem **Real Internet Test**. Kod globalnej warstwy P2P jest gotowy do testu, ale nie oznaczamy jeszcze połączenia Polska ↔ USA / CGNAT ↔ relay jako potwierdzonego, dopóki nie przejdzie rzeczywistego testu na dwóch niezależnych sieciach i stałym publicznym Konofix Node. Po zamknięciu tego etapu przechodzimy do **0.5.0 Rooms 2.0**.

---

**Konofix Chat — by Swir**  
https://github.com/Swir/Konofix
