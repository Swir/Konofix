# Konofix Chat — Roadmap

## 0.1.0 — Foundation ✅
- Tauri + Rust + libp2p
- nowoczesne GUI
- `#WORLD`
- nick i obecność
- mDNS/LAN
- pokoje tymczasowe

## 0.2.0 — Discovery / NAT ✅
- Kademlia DHT
- Identify
- AutoNAT
- DCUtR
- Circuit Relay client
- UPnP
- heartbeat obecności
- rozproszona rezerwacja nicków

## 0.3.0 — P2P File Transfer ✅
- wybór użytkownika i pliku
- Akceptuj/Odrzuć
- transfer po 256 KiB
- pasek postępu
- pliki `.konofixpart`
- SHA-256
- anulowanie i limity
- ostrzeganie o wykonywalnych plikach

## 0.4.0 — Global Network Core ✅
- Circuit Relay server w klientach
- automatyczna rezerwacja przez relay bootstrapu
- lokalny cache znanych peerów
- ponowne łączenie przez cache
- `Konofix Node` bootstrap/DHT/relay/AutoNAT/GossipSub
- stały Peer ID Node
- skrypty build/test dla Windows

## 0.4.1 — Rebrand / Test Foundation ✅
- [x] pełny rebranding **Konofix Chat**
- [x] stopka `by Swir • GitHub`
- [x] repo `Swir/Konofix` jako główne źródło projektu
- [x] odzyskanie pełnego źródła do normalnej struktury repo
- [x] Windows CI: TypeScript + Rust
- [x] skrypt precheck publicznego bootstrapu

## 0.4.2 — Real Internet Test 🚧
- [x] poprawiony Windows CI i przywrócony `tsconfig.json`
- [x] dodana wymagana ikona Windows/Tauri i poprawiony pipeline build
- [x] `Konofix Node --public-host` generuje gotowe adresy bootstrap TCP/QUIC
- [x] `run-node.bat` prowadzi użytkownika przez uruchomienie noda
- [x] walidacja pełnego multiaddr w `internet-test.ps1`
- [ ] pierwszy stabilny publiczny/community Konofix Node
- [ ] dwa komputery w różnych sieciach
- [ ] test CGNAT ↔ publiczny Node ↔ CGNAT
- [ ] test TCP, QUIC, relay i DCUtR
- [ ] poprawki po realnych testach

## 0.5.0 — Rooms 2.0
- pełna synchronizacja członków pokoju
- licznik osób w pokoju
- prywatne pokoje zapraszane linkiem
- właściciel opuszcza aplikację → pokój znika
- flood protection per pokój

## 0.6.0 — Private Chat
- prywatne rozmowy P2P
- osobne okna/zakładki
- E2E dla prywatnych wiadomości
- blokowanie użytkowników
- lokalna lista ignorowanych Peer ID

## 0.7.0 — Safety / Anti-Spam
- rate limiting
- reputacja lokalna
- zgłoszenia i blokady
- ochrona przed nick floodingiem
- limity reklamowania peerów i pokojów

## 0.8.0 — UX / Release
- auto-update
- instalator Windows
- podpisywanie buildów
- autostart opcjonalny
- pełne tłumaczenia PL/EN
- testy obciążeniowe `#WORLD`

## 1.0.0 — Public Release
- stabilny globalny `#WORLD`
- community bootstrap pool
- Windows release
- dokumentacja operatorów node
- protokół zamrożony dla 1.x

## Później
- klient WWW/WebRTC/WebTransport
- Android
- iOS/Linux
