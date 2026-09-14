# Konofix Chat 0.4.1

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

## 0.4.1 — branding + przygotowanie realnego testu Internetu

- pełny branding **Konofix Chat** w GUI, Tauri, Rust, protokołach i dokumentacji,
- logo aplikacji `K`,
- stała stopka `by Swir • GitHub`,
- link do `https://github.com/Swir/Konofix` otwierany z aplikacji,
- identyfikator Windows/Tauri `info.swir.konofixchat`,
- `Konofix Node` jako bootstrap/DHT/relay,
- tymczasowe transfery `.konofixpart`,
- GitHub Actions `Windows CI` dla TypeScript + Rust,
- `scripts/internet-test.ps1` do wstępnej kontroli publicznego bootstrapu.

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

GitHub wykonuje dodatkowo analogiczną kontrolę na `windows-latest` po każdym pushu do `main`.

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
konofix-node.exe --port 45555
```

Przykładowy adres bootstrap:

```text
/ip4/203.0.113.10/tcp/45555/p2p/12D3KooW...
```

Przed testem można wykonać:

```powershell
.\scripts\internet-test.ps1 -Bootstrap "/ip4/203.0.113.10/tcp/45555/p2p/12D3KooW..."
```

Node nie jest serwerem kont ani archiwum czatu. Służy jako punkt wejścia do DHT i relay, gdy bezpośrednie połączenie jest niemożliwe.

## Dane lokalne

- cache peerów: `%LOCALAPPDATA%\Konofix Chat\peer-cache.json`
- tożsamość Node: `%LOCALAPPDATA%\Konofix Chat\node-identity.key`
- pobrane pliki: `Pobrane\Konofix Chat`

## Status

`0.4.1` przygotowuje projekt do pierwszego pełnego testu Windows ↔ Internet ↔ Windows. Do zamknięcia etapu 0.4.1 nadal wymagamy realnego testu na dwóch niezależnych łączach oraz publicznego Konofix Node z trwałym Peer ID. Po tym przechodzimy zgodnie z roadmapą do **0.5.0 Rooms 2.0**.

---

**Konofix Chat — by Swir**  
https://github.com/Swir/Konofix
