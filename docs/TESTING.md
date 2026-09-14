# Konofix Chat 0.4.2 — plan testów

Ten dokument opisuje minimalny zestaw testów wymagany przed pierwszym wydaniem testowym przeznaczonym do połączeń między różnymi krajami i niezależnymi sieciami.

## 1. Kontrola lokalna

Na Windows 11:

```powershell
.\scripts\check.ps1
```

Kontrola musi przejść bez błędów dla:

- TypeScript/Vite,
- aplikacji Rust/Tauri,
- `konofix-node`.

GitHub Actions wykonuje ten sam podstawowy zestaw na `windows-latest`.

## 2. Test LAN — baseline

Przed Internetem sprawdź dwa komputery w jednym LAN:

1. Uruchom Konofix Chat na obu komputerach.
2. Użyj różnych nicków.
3. Oba komputery powinny znaleźć się przez mDNS.
4. Wyślij wiadomości w `#WORLD` w obie strony.
5. Utwórz pokój tymczasowy.
6. Wyślij mały plik oraz plik co najmniej 100 MB.
7. Anuluj jeden transfer w trakcie.
8. Zamknij hosta pokoju — pokój powinien zniknąć u drugiego klienta.

Jeżeli LAN nie przechodzi, nie przechodzimy do testu Internetu.

## 3. Publiczny Konofix Node

Najprościej uruchomić:

```text
run-node.bat
```

Skrypt zapyta o publiczny IP lub DNS.

Ręcznie:

```powershell
konofix-node.exe --port 45555 --public-host TWOJ_PUBLICZNY_IP_LUB_DNS
```

Na routerze/firewallu VPS muszą być dostępne:

- TCP 45555,
- UDP 45555.

Node wypisze gotowe multiaddr TCP i QUIC zakończone `/p2p/<PeerId>`.

Nie usuwaj `%LOCALAPPDATA%\Konofix Chat\node-identity.key`, jeżeli Peer ID noda ma być stabilny między restartami.

## 4. Precheck bootstrapu z klienta

Na każdym komputerze testowym:

```powershell
.\scripts\internet-test.ps1 -Bootstrap "/ip4/ADRES/tcp/45555/p2p/PEER_ID"
```

Dla DNS użyj `/dns4/nazwa...` lub `/dns/nazwa...`.

Precheck TCP musi zakończyć się sukcesem przed właściwym testem aplikacji. UDP/QUIC weryfikujemy z poziomu libp2p podczas testu.

## 5. Test kraj ↔ kraj

Minimalna konfiguracja:

| Rola | Wymaganie |
| --- | --- |
| Klient A | kraj/sieć A, np. Norwegia / LTE lub światłowód |
| Klient B | kraj/sieć B, np. Polska / inne ISP |
| Node | publiczny IP/DNS, najlepiej trzecia niezależna sieć |

Wykonaj kolejno:

1. Oba komputery dodają ten sam bootstrap.
2. Oba uruchamiają Konofix Chat z różnymi nickami.
3. Sprawdź, czy panel sieci pokazuje połączenie z bootstrapem i rosnącą liczbę peerów DHT.
4. Wyślij wiadomość A → B i B → A w `#WORLD`.
5. Utwórz pokój na A i sprawdź jego pojawienie się na B.
6. Wyślij plik A → B i B → A.
7. Porównaj rozmiar i SHA-256 pliku źródłowego oraz odebranego.
8. Zrestartuj oba klienty i sprawdź ponowne discovery/cache peerów.
9. Zrestartuj publiczny Node i potwierdź, że Peer ID pozostaje taki sam.
10. Powtórz test po kilku minutach bez ręcznego czyszczenia cache.

## 6. Test transportów i NAT

Test wykonujemy w kilku wariantach:

### A. TCP bootstrap

Użyj adresu `/tcp/45555/p2p/...` i potwierdź czat, pokój oraz transfer pliku.

### B. QUIC

Użyj adresu `/udp/45555/quic-v1/p2p/...` i sprawdź połączenie przez UDP/QUIC.

### C. Relay

Przynajmniej jeden klient powinien być za NAT/CGNAT bez przekierowanych portów. Potwierdź, że może wejść do sieci przez Circuit Relay.

### D. DCUtR

Przy połączeniu przez relay obserwuj log/status i sprawdź, czy po możliwym hole-punchingu połączenie może zostać podniesione do bezpośredniego.

### E. CGNAT ↔ Node ↔ CGNAT

Najważniejszy wariant przed publicznym test-release:

- klient A za CGNAT,
- klient B za innym CGNAT/NAT,
- publiczny Konofix Node osiągalny z obu stron.

## 7. Test rezerwacji nicku

1. Uruchom dwóch klientów z identycznym nickiem.
2. Powtórz z różną wielkością liter, np. `SWIR` i `swir`.
3. Po synchronizacji sieci tylko jeden Peer ID powinien utrzymać rezerwację.
4. Po wyjściu zwycięskiego peera nick powinien po wygaśnięciu dzierżawy znów być możliwy do przejęcia.

## 8. Test odporności

Sprawdź także:

- wyłączenie Wi‑Fi/LTE podczas transferu,
- zamknięcie aplikacji podczas transferu,
- restart Node w trakcie działania klientów,
- błędny bootstrap,
- nieosiągalny bootstrap,
- duplikat bootstrapu,
- plik o niebezpiecznym rozszerzeniu,
- anulowanie transferu po obu stronach.

Aplikacja nie powinna się wywracać ani zostawiać gotowego pliku po transferze z błędnym SHA-256. Niedokończone dane pozostają wyłącznie jako pliki tymczasowe `.konofixpart` i powinny być sprzątane zgodnie z logiką transferu.

## 9. Co zapisać z każdego testu

Zapisz:

- wersję Konofix Chat,
- kraj i typ łącza obu klientów,
- typ NAT/CGNAT, jeżeli jest znany,
- użyty bootstrap TCP/QUIC,
- czy użyto relay,
- czy pojawił się DCUtR,
- czat: PASS/FAIL,
- pokoje: PASS/FAIL,
- pliki: PASS/FAIL,
- reconnect: PASS/FAIL,
- nick conflict: PASS/FAIL,
- opis błędu i moment wystąpienia.

Nie publikuj prywatnych kluczy tożsamości ani żadnych sekretów.

## 10. Warunek pierwszego test-release

Pierwszy GitHub Release przeznaczony do testów między krajami robimy, gdy:

- Windows CI jest zielony,
- produkcyjny Windows build powstaje w CI,
- `konofix-node.exe` powstaje w CI,
- aplikacja i Node mają tę samą wersję dokumentacyjną,
- instrukcja uruchomienia publicznego noda jest gotowa,
- mamy co najmniej jeden realistyczny sposób osiągnięcia publicznego bootstrapu.

Pełne zamknięcie etapu 0.4.2 wymaga dodatkowo udanego testu na dwóch niezależnych łączach oraz poprawek znalezionych podczas testu.