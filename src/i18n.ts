type Locale = 'en' | 'pl' | 'no' | 'de' | 'fr' | 'es' | 'uk';

const SUPPORTED: Locale[] = ['en', 'pl', 'no', 'de', 'fr', 'es', 'uk'];
const STORAGE_KEY = 'konofix.locale';

const exact: Record<Exclude<Locale, 'pl'>, Record<string, string>> = {
  en: {
    'Wchodzisz. Rozmawiasz. Wychodzisz — znikasz z sieci.': 'Join. Chat. Leave — disappear from the network.',
    '◆ bez konta': '◆ no account',
    '◆ bez historii na serwerze': '◆ no server-side history',
    '◆ transfer plików P2P': '◆ P2P file transfer',
    'Wejdź do #WORLD': 'Join #WORLD',
    'Wybierz nick. Jest rezerwowany tylko wtedy, gdy jesteś online.': 'Choose a nickname. It is reserved only while you are online.',
    'Twój nick': 'Your nickname',
    'Połącz z siecią': 'Connect to network',
    'Zaawansowane ustawienia sieci': 'Advanced network settings',
    '🔒 Połączenia są szyfrowane przez libp2p. Nick nie jest kontem.': '🔒 Connections are encrypted by libp2p. A nickname is not an account.',
    'POKOJE TYMCZASOWE': 'TEMPORARY ROOMS',
    '＋ Utwórz pokój': '＋ Create room',
    'Wspólny globalny kanał P2P': 'Shared global P2P channel',
    'Pokój istnieje tylko, gdy jego host jest online': 'The room exists only while its host is online',
    '📎 Wyślij plik': '📎 Send file',
    'Napisz pierwszą wiadomość.': 'Write the first message.',
    'Ty · nick zarezerwowany': 'You · nickname reserved',
    'TRANSFERY': 'TRANSFERS',
    'Brak transferów': 'No transfers',
    'Czeka na akceptację': 'Waiting for acceptance',
    'Wysyłanie': 'Sending',
    'Pobieranie': 'Receiving',
    'Weryfikacja SHA‑256': 'Verifying SHA-256',
    'Gotowe': 'Completed',
    'Odrzucono': 'Rejected',
    'Błąd': 'Error',
    'Anulowano': 'Cancelled',
    'Wyślij plik': 'Send file',
    'Wybierz użytkownika. Potem otworzy się systemowe okno wyboru pliku.': 'Choose a user. The system file picker will open next.',
    'PRZYCHODZĄCY PLIK P2P': 'INCOMING P2P FILE',
    'Odrzuć': 'Reject',
    'Akceptuj': 'Accept',
    'Stan sieci': 'Network status',
    'Połączenia': 'Connections',
    'Peerzy DHT': 'DHT peers',
    'Bootstrapy': 'Bootstraps',
    'Adres bootstrap peera': 'Bootstrap peer address',
    'Dodaj': 'Add',
    'Moje adresy nasłuchu': 'My listen addresses',
    'Bootstrap pomaga tylko znaleźć sieć. Nie jest serwerem wiadomości ani magazynem plików.': 'A bootstrap only helps discover the network. It is not a message server or file store.',
    'P2P OFFLINE': 'P2P OFFLINE',
    'SZUKAM PEERÓW': 'SEARCHING FOR PEERS',
    'P2P ONLINE': 'P2P ONLINE',
    'AKTYWNY': 'ACTIVE',
    'Pojawią się po uruchomieniu sieci.': 'They will appear after the network starts.',
    'Brak własnych bootstrapów. LAN działa przez mDNS, a aplikacja próbuje też użyć zapamiętanych peerów.': 'No custom bootstraps. LAN works through mDNS, and the app also tries remembered peers.',
  },
  no: {
    'Wchodzisz. Rozmawiasz. Wychodzisz — znikasz z sieci.': 'Bli med. Chat. Gå ut — og forsvinn fra nettverket.',
    '◆ bez konta': '◆ ingen konto', '◆ bez historii na serwerze': '◆ ingen historikk på serveren', '◆ transfer plików P2P': '◆ P2P-filoverføring',
    'Wejdź do #WORLD': 'Bli med i #WORLD', 'Wybierz nick. Jest rezerwowany tylko wtedy, gdy jesteś online.': 'Velg et kallenavn. Det reserveres bare mens du er pålogget.',
    'Twój nick': 'Ditt kallenavn', 'Połącz z siecią': 'Koble til nettverket', 'Zaawansowane ustawienia sieci': 'Avanserte nettverksinnstillinger',
    'POKOJE TYMCZASOWE': 'MIDLERTIDIGE ROM', '＋ Utwórz pokój': '＋ Opprett rom', 'Wspólny globalny kanał P2P': 'Felles global P2P-kanal',
    'Pokój istnieje tylko, gdy jego host jest online': 'Rommet finnes bare mens verten er pålogget', '📎 Wyślij plik': '📎 Send fil', 'Napisz pierwszą wiadomość.': 'Skriv den første meldingen.',
    'Ty · nick zarezerwowany': 'Du · kallenavn reservert', 'TRANSFERY': 'OVERFØRINGER', 'Brak transferów': 'Ingen overføringer',
    'Wyślij plik': 'Send fil', 'Odrzuć': 'Avvis', 'Akceptuj': 'Godta', 'Stan sieci': 'Nettverksstatus', 'Połączenia': 'Tilkoblinger', 'Peerzy DHT': 'DHT-noder',
    'Bootstrapy': 'Bootstrap-noder', 'Adres bootstrap peera': 'Adresse til bootstrap-node', 'Dodaj': 'Legg til', 'Moje adresy nasłuchu': 'Mine lytteadresser',
    'Czeka na akceptację': 'Venter på godkjenning', 'Wysyłanie': 'Sender', 'Pobieranie': 'Mottar', 'Weryfikacja SHA‑256': 'Verifiserer SHA-256', 'Gotowe': 'Ferdig', 'Odrzucono': 'Avvist', 'Błąd': 'Feil', 'Anulowano': 'Avbrutt'
  },
  de: {
    'Wejdź do #WORLD': '#WORLD beitreten', 'Twój nick': 'Dein Nickname', 'Połącz z siecią': 'Mit Netzwerk verbinden', 'Zaawansowane ustawienia sieci': 'Erweiterte Netzwerkeinstellungen',
    'POKOJE TYMCZASOWE': 'TEMPORÄRE RÄUME', '＋ Utwórz pokój': '＋ Raum erstellen', '📎 Wyślij plik': '📎 Datei senden', 'TRANSFERY': 'ÜBERTRAGUNGEN', 'Brak transferów': 'Keine Übertragungen',
    'Odrzuć': 'Ablehnen', 'Akceptuj': 'Akzeptieren', 'Stan sieci': 'Netzwerkstatus', 'Połączenia': 'Verbindungen', 'Dodaj': 'Hinzufügen', 'Błąd': 'Fehler', 'Gotowe': 'Fertig'
  },
  fr: {
    'Wejdź do #WORLD': 'Rejoindre #WORLD', 'Twój nick': 'Votre pseudo', 'Połącz z siecią': 'Se connecter au réseau', 'Zaawansowane ustawienia sieci': 'Paramètres réseau avancés',
    'POKOJE TYMCZASOWE': 'SALONS TEMPORAIRES', '＋ Utwórz pokój': '＋ Créer un salon', '📎 Wyślij plik': '📎 Envoyer un fichier', 'TRANSFERY': 'TRANSFERTS', 'Brak transferów': 'Aucun transfert',
    'Odrzuć': 'Refuser', 'Akceptuj': 'Accepter', 'Stan sieci': 'État du réseau', 'Połączenia': 'Connexions', 'Dodaj': 'Ajouter', 'Błąd': 'Erreur', 'Gotowe': 'Terminé'
  },
  es: {
    'Wejdź do #WORLD': 'Entrar en #WORLD', 'Twój nick': 'Tu apodo', 'Połącz z siecią': 'Conectar a la red', 'Zaawansowane ustawienia sieci': 'Ajustes de red avanzados',
    'POKOJE TYMCZASOWE': 'SALAS TEMPORALES', '＋ Utwórz pokój': '＋ Crear sala', '📎 Wyślij plik': '📎 Enviar archivo', 'TRANSFERY': 'TRANSFERENCIAS', 'Brak transferów': 'Sin transferencias',
    'Odrzuć': 'Rechazar', 'Akceptuj': 'Aceptar', 'Stan sieci': 'Estado de red', 'Połączenia': 'Conexiones', 'Dodaj': 'Añadir', 'Błąd': 'Error', 'Gotowe': 'Completado'
  },
  uk: {
    'Wejdź do #WORLD': 'Увійти до #WORLD', 'Twój nick': 'Ваш нік', 'Połącz z siecią': 'Підключитися до мережі', 'Zaawansowane ustawienia sieci': 'Розширені налаштування мережі',
    'POKOJE TYMCZASOWE': 'ТИМЧАСОВІ КІМНАТИ', '＋ Utwórz pokój': '＋ Створити кімнату', '📎 Wyślij plik': '📎 Надіслати файл', 'TRANSFERY': 'ПЕРЕДАЧІ', 'Brak transferów': 'Немає передач',
    'Odrzuć': 'Відхилити', 'Akceptuj': 'Прийняти', 'Stan sieci': 'Стан мережі', 'Połączenia': 'З’єднання', 'Dodaj': 'Додати', 'Błąd': 'Помилка', 'Gotowe': 'Готово'
  }
};

const attrs: Record<Exclude<Locale, 'pl'>, Record<string, string>> = {
  en: {
    'np. SWIR': 'e.g. SWIR', 'Napisz wiadomość do': 'Write a message to', 'Wyślij': 'Send', 'Odśwież discovery': 'Refresh discovery',
    'Sieć P2P': 'P2P network', 'Rozłącz': 'Disconnect', 'Anuluj': 'Cancel', 'Wyślij plik do': 'Send file to'
  },
  no: { 'np. SWIR': 'f.eks. SWIR', 'Napisz wiadomość do': 'Skriv en melding til', 'Wyślij': 'Send', 'Odśwież discovery': 'Oppdater discovery', 'Sieć P2P': 'P2P-nettverk', 'Rozłącz': 'Koble fra', 'Anuluj': 'Avbryt', 'Wyślij plik do': 'Send fil til' },
  de: { 'np. SWIR': 'z. B. SWIR', 'Napisz wiadomość do': 'Nachricht an', 'Wyślij': 'Senden', 'Rozłącz': 'Trennen', 'Anuluj': 'Abbrechen' },
  fr: { 'np. SWIR': 'ex. SWIR', 'Napisz wiadomość do': 'Écrire à', 'Wyślij': 'Envoyer', 'Rozłącz': 'Déconnecter', 'Anuluj': 'Annuler' },
  es: { 'np. SWIR': 'p. ej. SWIR', 'Napisz wiadomość do': 'Escribir a', 'Wyślij': 'Enviar', 'Rozłącz': 'Desconectar', 'Anuluj': 'Cancelar' },
  uk: { 'np. SWIR': 'напр. SWIR', 'Napisz wiadomość do': 'Написати повідомлення', 'Wyślij': 'Надіслати', 'Rozłącz': 'Від’єднати', 'Anuluj': 'Скасувати' }
};

function systemLocale(): Locale {
  const saved = localStorage.getItem(STORAGE_KEY)?.toLowerCase().split('-')[0] as Locale | undefined;
  if (saved && SUPPORTED.includes(saved)) return saved;
  for (const candidate of navigator.languages?.length ? navigator.languages : [navigator.language]) {
    const code = candidate.toLowerCase().split('-')[0] as Locale;
    if (SUPPORTED.includes(code)) return code;
  }
  return 'en';
}

const locale = systemLocale();
document.documentElement.lang = locale;

function dynamicTranslate(value: string): string {
  if (locale === 'pl') return value;
  const table = exact[locale] || exact.en;
  const trimmed = value.trim();
  if (table[trimmed]) return value.replace(trimmed, table[trimmed]);

  const englishFallback = exact.en;
  const use = (key: string) => table[key] || englishFallback[key] || key;
  return value
    .replace(/(\d+) połączeń/g, (_m, n) => locale === 'no' ? `${n} tilkoblinger` : locale === 'de' ? `${n} Verbindungen` : locale === 'fr' ? `${n} connexions` : locale === 'es' ? `${n} conexiones` : locale === 'uk' ? `${n} з’єднань` : `${n} connections`)
    .replace(/^Witaj w (.+)$/u, (_m, room) => locale === 'no' ? `Velkommen til ${room}` : locale === 'de' ? `Willkommen in ${room}` : locale === 'fr' ? `Bienvenue dans ${room}` : locale === 'es' ? `Bienvenido a ${room}` : locale === 'uk' ? `Ласкаво просимо до ${room}` : `Welcome to ${room}`)
    .replace(/^Napisz wiadomość do (.+)…$/u, (_m, room) => `${attrs[locale]?.['Napisz wiadomość do'] || attrs.en['Napisz wiadomość do']} ${room}…`)
    .replace('PRZYCHODZĄCY PLIK P2P', use('PRZYCHODZĄCY PLIK P2P'));
}

function translateElement(root: ParentNode) {
  if (locale === 'pl') return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode as Text);
  for (const node of textNodes) {
    if (!node.parentElement || ['SCRIPT', 'STYLE', 'CODE'].includes(node.parentElement.tagName)) continue;
    const translated = dynamicTranslate(node.nodeValue || '');
    if (translated !== node.nodeValue) node.nodeValue = translated;
  }

  const elements = root instanceof Element ? [root, ...root.querySelectorAll('*')] : [...root.querySelectorAll('*')];
  for (const el of elements) {
    if (!(el instanceof HTMLElement)) continue;
    for (const name of ['placeholder', 'title', 'aria-label']) {
      const value = el.getAttribute(name);
      if (!value) continue;
      const table = attrs[locale] || attrs.en;
      let next = table[value] || attrs.en[value] || value;
      for (const [key, translated] of Object.entries(table)) {
        if (next.includes(key)) next = next.replace(key, translated);
      }
      if (next !== value) el.setAttribute(name, next);
    }
  }
}

const observer = new MutationObserver(records => {
  for (const record of records) {
    for (const node of record.addedNodes) {
      if (node instanceof Element) translateElement(node);
      else if (node.parentElement) translateElement(node.parentElement);
    }
  }
});

translateElement(document.body);
observer.observe(document.body, { childList: true, subtree: true });

export const currentLocale = locale;
