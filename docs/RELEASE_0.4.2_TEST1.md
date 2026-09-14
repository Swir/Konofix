# Konofix Chat 0.4.2 Test 1 — Cross-country P2P Preview

To jest **pierwsze testowe wydanie Konofix Chat** przeznaczone do sprawdzania komunikacji P2P przez Internet pomiędzy różnymi sieciami i krajami.

## Co zawiera

- Konofix Chat dla Windows,
- `konofix-node.exe` — bootstrap / Kademlia DHT / Circuit Relay,
- TCP + QUIC,
- AutoNAT + DCUtR,
- globalny `#WORLD`,
- tymczasowe pokoje,
- rozproszoną rezerwację nicków,
- transfer plików P2P z akceptacją, chunkami 256 KiB i SHA-256,
- lokalny cache poznanych peerów,
- instrukcję testu kraj ↔ kraj.

## Najprostszy test Internetu

1. Uruchom `konofix-node.exe` na komputerze/VPS z publicznym IP.
2. Otwórz TCP i UDP `45555`.
3. Uruchom:

```powershell
konofix-node.exe --port 45555 --public-host TWOJ_PUBLICZNY_IP_LUB_DNS
```

4. Skopiuj wypisany `BOOTSTRAP TCP`.
5. Na dwóch komputerach w różnych sieciach/krajach dodaj ten sam bootstrap w **Ustawienia sieci → Bootstrap**.
6. Sprawdź `#WORLD`, pokój tymczasowy i transfer pliku w obie strony.

Pełna macierz testów znajduje się w `TESTING.md` / `docs/TESTING.md`.

## Ważne ograniczenia tego test-release

- To jest **pre-release**, nie finalna wersja publiczna.
- Nie ma jeszcze wbudowanej puli publicznych community bootstrapów — testujący może uruchomić własny Konofix Node.
- `#WORLD` jest publicznym kanałem rozproszonym. Transport libp2p jest szyfrowany, ale publiczny kanał nie jest prywatnym czatem E2E.
- Prywatne rozmowy P2P/E2E są zaplanowane na późniejszy etap roadmapy.
- Build Windows może wyświetlić ostrzeżenie SmartScreen, ponieważ wydanie testowe nie jest jeszcze podpisane komercyjnym certyfikatem.

## Co chcemy potwierdzić

Najważniejszy scenariusz:

**klient za NAT/CGNAT w kraju A ↔ publiczny Konofix Node ↔ klient za innym NAT/CGNAT w kraju B**

Testujemy:

- TCP,
- QUIC,
- DHT discovery,
- Circuit Relay,
- DCUtR / hole punching,
- reconnect/cache peerów,
- rezerwację nicku,
- czat,
- pokoje,
- transfer plików i SHA-256.

## Zgłaszając błąd

Podaj wersję, kraj/typ sieci obu klientów, użyty bootstrap, wynik czatu/pokoju/transferu/reconnect oraz moment wystąpienia problemu.

Nie publikuj prywatnego pliku `node-identity.key` ani innych sekretów.

---

**Konofix Chat — by Swir**
