# Testy Konofix Chat 0.4.1

## 1. Kontrola lokalna

```powershell
.\scripts\check.ps1
```

Skrypt sprawdza frontend i Rust. Repo ma także workflow `.github/workflows/windows-ci.yml` uruchamiany na Windowsie.

## 2. Test LAN

1. Uruchom aplikację na dwóch komputerach w jednym LAN.
2. Użyj różnych nicków.
3. Oba komputery powinny pojawić się w `#WORLD` przez mDNS.
4. Wyślij wiadomość i plik.
5. Zamknij hosta pokoju — pokój powinien zniknąć.

## 3. Precheck publicznego Node

```powershell
.\scripts\internet-test.ps1 -Bootstrap "/ip4/ADRES/tcp/45555/p2p/PEER_ID"
```

## 4. Real Internet Test

1. Na publicznym komputerze/VPS uruchom `konofix-node.exe --port 45555`.
2. Otwórz TCP i UDP 45555.
3. Skopiuj multiaddr z prawdziwym publicznym IP i Peer ID.
4. Dodaj bootstrap na dwóch klientach w różnych sieciach.
5. Sprawdź panel: bootstrap, DHT, NAT, relay i adresy nasłuchu.
6. Sprawdź `#WORLD`, tymczasowy pokój i transfer pliku.
7. Uruchom klientów ponownie — cache peerów powinien próbować wcześniejszych adresów.
8. Powtórz test przy jednym lub obu klientach za CGNAT.

## 5. Test nicku

Uruchom dwóch klientów z identycznym nickiem, także w różnej wielkości liter. Po zsynchronizowaniu sieci tylko jeden aktywny Peer ID powinien zachować rezerwację nicku.

## Warunek zamknięcia 0.4.1

Etap uznajemy za ukończony dopiero po udanym teście na dwóch niezależnych łączach i ustaleniu pierwszego stabilnego community bootstrapu.
