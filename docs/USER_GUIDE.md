# Konofix Chat 0.6.0 user guide

Konofix is a live Windows messenger with a public WORLD room, temporary rooms, private messages, file sharing and audio. You choose a nickname instead of registering an account. Every connected app participates in the native P2P network; public third-party services also help Internet users find each other and exchange text.

This guide describes implemented behavior and known limits. It does not certify all networks or every maximum-size/large-group scenario. See the [README](../README.md), [release notes](RELEASE_0.6.0.md), [acceptance record](evidence/CHAT_AUDIO_ACCEPTANCE_20261013.md) and [qualification roadmap](../ROADMAP.md) for their separate status.

## Install or upgrade

1. Open [GitHub Releases](https://github.com/Swir/Konofix/releases/latest) and select the Windows `setup.exe` for the stable release. The automatically generated source-code ZIP is not an installer.
2. Compare the download's SHA-256 with the release checksum if you need to verify the file. For example, run `Get-FileHash -Algorithm SHA256 "C:\path\to\Konofix-setup.exe"` using the actual filename.
3. Close an older running Konofix instance, install, then open **Konofix Chat** from the Start menu. Use the same version on each participant's PC.
4. Use normal Windows microphone permission and application-specific firewall settings. Do not disable Windows security. Current packages have no Microsoft Authenticode signature; a hash confirms bytes, not publisher reputation.

The desktop target is Windows 11 with WebView2. The bundle may additionally contain an MSI, headless Node, Netprobe and testing tools. Node/Netprobe do not open the chat interface. Linux support in this repository is for the headless Node, not a released Linux desktop chat package.

## Enter WORLD and find people

Choose a nickname and color, leave **public WORLD discovery** selected for Internet use, then connect. Use distinct nicknames to avoid conflicts. There is no email, password-based account registration or phone-number requirement.

On one suitable LAN, mDNS discovers other participants automatically. Guest-Wi-Fi isolation, separate VLANs and multicast filtering can prevent that discovery. Across the Internet, public discovery combines native P2P contact discovery with several third-party Nostr relays for presence/text fallback. Keep the option enabled on both PCs if you expect that automatic Internet path. An optional reachable participant address can also be added in network settings.

The online list is live presence, not an address book or a promise that a media connection will succeed. Presence expiry and reconnects can take time. Network settings shows native connections and the connected public-relay count; these are diagnostic snapshots, not proof of the route of every message.

## Public text and temporary rooms

Type in **#WORLD** to address everyone currently reached by that public room. Emoji can be chosen from the picker, and nickname colors help distinguish speakers. Treat everything posted to WORLD or an unprotected room as public.

Create a temporary room using the room creation control, give it a title and leave the optional password empty for a public room. Public-room announcements and text can use the Internet fallback. Other participants can select the room from the list. Its owner can manage the room; it is not a permanent hosted community with offline history. Public relay room announcements disappear when the owner closes the room or its presence expires.

An optional room password restricts native room access. Password-protected rooms do not expose their names/passwords or membership authorization through the public relay fallback, and need native connectivity. Their group voice is unavailable in this release. Do not assume a password can make a public WORLD post private.

## Private messages

Choose a participant's private-chat action. The private window provides text, emoji and attachment controls. New incoming private conversations show an **Open / Ignore** notification; network settings also lets you disable new incoming private conversations. Ignore is a local session choice, not a global ban on the person.

Native private messages use an authenticated encrypted libp2p connection. A relay participant uses recipient-addressed NIP-44 encryption; public relay operators see ciphertext rather than private-message contents. The peer or key selected in the UI is the recipient identity: a familiar nickname alone is not verified identity.

Keep the recipient online. There is no promise of offline delivery, permanent server-side conversation history or a human read receipt. Avoid sending sensitive information to someone whose identity you have not verified.

## Share files and preview images

### Share in WORLD or a room

1. Open the intended room and choose **Share file**.
2. Select a regular file. A card with its name and size is announced to the room; the file is not automatically pushed to everyone.
3. Another participant chooses **Download**, or **Preview** for a supported image. This explicit action requests bytes from your online app.
4. Watch the Transfers panel for requesting, sending/receiving, verification and completion. Either side can cancel an active transfer.

There is one file action: PNG, JPEG, GIF and WebP content is recognized automatically from its file header. Supported images up to **8 MiB** can be previewed after an explicit request. Larger images remain ordinary downloadable files. A preview does not execute the downloaded file.

Public offers expire after **10 minutes**. Keep the sender online and the file available until the download finishes. A visible old card is not a cloud-hosted copy. A newly connected participant may need a fresh offer after an expiry or reconnect.

### Send privately

Use the attachment button in the private conversation, select a file and wait for the recipient to accept. An offered private file can be rejected. Native and WebRTC file streams use chunks, progress and cancellation instead of sending one enormous message.

### Limits and integrity

| Path or operation | Implemented limit | Meaning |
|---|---|---|
| Native/WebRTC file transfer | 32 GiB per file | Maximum accepted file size; actual delivery also needs connectivity, time and disk space. Not every maximum-size case has been field-tested. |
| Legacy encrypted relay file fallback | 2 MiB per file | Separate small-file route when available; not a universal fallback for a larger WebRTC transfer. |
| Image preview | 8 MiB | PNG/JPEG/GIF/WebP only, checked by file header. |
| Public offer lifetime | 10 minutes | Share again if it expires. |

Received downloads are saved under **Downloads\Konofix Chat** using safe names and non-overwriting saves. Size and SHA-256 checks must pass before success is reported. Preview-only files are temporarily staged and removed after a successful preview read. Integrity verification does not scan for malware: do not run unknown programs or documents simply because their transfer hash matches.

Public relays carry public offer metadata and encrypted connection setup, **not the bytes of large/public WebRTC files**. The legacy private small-file fallback does carry encrypted file chunks. Transfer speed depends on both peers' connections, disks and network conditions.

## Private audio calls

1. Select the other participant's private chat. When its public WORLD signaling identity is available, the phone button starts a call.
2. The other participant accepts or rejects the incoming call. Incoming and outgoing call tones indicate the call state.
3. Permit microphone access when prompted. The private window offers microphone mute/unmute and hangup.
4. End the call using hangup; reopening a text window is not the same as placing a new call.

Private calls use encrypted WebRTC audio with encrypted recipient-addressed signaling over WORLD relays. The phone action currently requires a public-relay participant identity; a native-only private text entry may not offer it. Public discovery must be enabled for voice setup. Keep both apps online, and use the same release.

The current audio fix uses the normal audio-element playback path, handles repeated/late connection answers and prevents a separate file session's shutdown from clearing call playback. The user confirmed private sound on both PCs and no return of the reported hangup error on the accepted candidate. That does not prove every router or sound device combination.

## WORLD voice: one speaker per minute

WORLD has a visible speaking queue. Select **I want to speak** to request a turn. The panel shows the current speaker, remaining time and waiting participants. When eligible, the panel offers **Start my 60 seconds**; an already queued participant can also advance automatically when the previous turn ends and local microphone access permits it.

After **60 seconds**, the current speaker's microphone turn ends so the next participant can take over. **Finish** releases the turn early. Leaving the queue withdraws your request. The one-minute rule applies to WORLD, not to private calls or public-room group voice.

Queue announcements use signed public events and bounded recovery for delayed/repeated network messages. They are distributed state, not a centrally moderated radio service. A network outage can delay convergence; if a turn cannot start, check the microphone and connection status before requesting again.

To stop listening to WORLD locally, enable **Mute WORLD voice** in network settings. This does not mute private calls or public-room voice, and does not mute everyone else's WORLD audio.

## Voice in your public room

Open an unprotected user-created room, then choose its join-voice action. Other room participants can join and speak simultaneously without WORLD's one-minute timer. Leave voice when finished or before changing activity.

Audio is exchanged between participants. More participants create more peer connections and bandwidth/CPU demand; this is not a promise of large-scale conference capacity. Password-protected room voice is unavailable.

Private calls, WORLD speaking and public-room voice share microphone ownership. Starting another microphone activity ends/releases the previous voice mode as needed. Do not expect simultaneous independent microphone sessions in every mode.

## Sound tests and troubleshooting

Open **Network settings** to test speakers and microphone. The microphone test displays an input meter; the speaker test checks local output. A successful local test does not prove that remote audio crosses the network.

| Symptom | Check |
|---|---|
| Nobody appears on the same LAN | Same current release, both connected, distinct nicknames, no guest/client isolation or multicast filtering; allow only the intended app through the firewall. |
| Nobody appears across networks | Enable public WORLD discovery on both apps, check Internet access and public-relay connection status, allow time for reconnection. Third-party relay availability is not guaranteed. |
| Text works but audio or large files do not | WebRTC may be blocked by the two networks' NAT/firewall combination. STUN is configured; TURN is not. Visible presence alone is not a working media route. |
| Microphone cannot start | Check Windows microphone/privacy permission and default input device, close another app holding exclusive input, finish another Konofix voice/test mode and retry. |
| Call connects but is silent | Test local microphone/speakers on both PCs, check private microphone mute and Windows app output/volume, interact with the app if it requests playback permission, verify the same release. |
| WORLD is silent but private audio works | Check **Mute WORLD voice**, whether someone currently owns a turn, and local output settings. |
| File card appears but cannot download | Sender still online, offer not expired, same current build, enough disk space, and a usable native/WebRTC route. Re-share an expired offer. |
| Update check fails | This release requires manual upgrade; the signed update feed is not configured. Download the stable installer from GitHub. |

Do not open arbitrary inbound ports or disable system protection as a blanket workaround. For a report, include release/version, both Windows versions, exact steps, which direction is silent, whether WORLD/private text works, network type and the visible error. Remove secrets and private addresses unless they are genuinely needed in a private diagnostic exchange.

## Languages

The application supports **English, Polish, Norwegian, German, French, Spanish and Ukrainian**. At startup it checks a saved locale preference, then the system/WebView language list, then falls back to English. Norwegian `nb`/`nn` and Ukrainian `ua` aliases are normalized. This describes the application UI, not a guarantee that every installer/system dialog is translated into all seven languages.

## Updates

The implemented client checks shortly after startup and offers a manual **Check for updates** action in settings. It accepts stable versions only and requests user approval before downloading/installing a valid signed update and restarting.

**For 0.6.0, install manually from GitHub.** Signed updater publication is not configured, so the client implementation is not an active automatic-update service. A future release needs a valid signed updater package and manifest matching the configured key. Never work around signature errors by disabling verification. Updater signatures and Microsoft Authenticode certificates serve different purposes; the current installer has no Authenticode signature.

## What “without your own server” means

You do not need a Konofix account server, rented VPS or central file store. The apps themselves form a native network and can help other participants when reachable and consented. An optional headless Node is an always-on participant, not a mandatory authority.

However, Internet use is **not independent of public infrastructure**:

- The public Amino DHT can supply discovery hints, which Konofix then validates.
- Four replaceable public Nostr relays carry signed live public content and encrypted private/control envelopes. Public room content and metadata are visible to their operators.
- Cloudflare/Google STUN supplies WebRTC address discovery. It does not relay media. **No TURN service is configured**, so some restrictive NAT/CGNAT combinations cannot carry WebRTC audio or large files.
- Native participant circuit relays, when available, are separate from TURN and do not automatically provide WebRTC relay service.

Each path has different connectivity and privacy properties. It is possible for WORLD/private text to work while a file or audio path fails. No claim of universal zero-configuration Internet media connectivity is made.

## Privacy, identity and local data

WORLD/unprotected-room messages are public. Relay operators can retain or correlate public content, identifiers, IP addresses, timing and encrypted-envelope sizes even when events are marked short-lived. Encryption does not hide all metadata or protect a compromised endpoint. Nicknames are not verified personal identities.

The application stores settings and a persistent relay signing identity locally. Native peer caching and optional Node/KNP identities also persist. Chat windows are live application state, not guaranteed offline storage. Downloaded files remain under Downloads until you remove them. Do not share local storage, identity keys or KNP profile directories in a bug report.

For advanced contact-only KonoNexus use, see [the KNP guide](KNP_CHAT_BETA.md). It needs separately verified NodeIDs and reachable UDP endpoints and does not provide automatic KNP WAN discovery. Ordinary WORLD messaging does not require that panel.

Security reports: [private disclosure policy](../.github/SECURITY.md). Formal multi-network/load qualification: [testing](TESTING.md) and [Global Beta plan](GLOBAL_BETA.md). Their unfinished evidence gates are separate from this stable application's implemented feature list.
