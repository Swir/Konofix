# Konofix Chat 0.5.3 — encrypted WAN private chat and files

## Candidate status

This version fixes the field report that public WORLD text worked across independent
networks while private conversations and file attachments did not. Native libp2p is
still preferred. When a participant is visible only through the public WORLD relay,
the UI now enables private chat and a bounded encrypted file route instead of sending
an unreachable native request.

Do not publish 0.5.3 as stable until the exact Windows candidate passes the physical
two-PC LAN/WAN test below. Automated tests prove implementation behavior, not public
relay availability on the tester's networks.

## Security and limits

- private text and fallback file envelopes use NIP-44 end-to-end encryption;
- each envelope is signed by the sender's persistent local Nostr identity and is
  addressed to the recipient's relay public key;
- relay file offers require explicit Accept or Reject;
- fallback files are limited to 2 MiB and 16 KiB plaintext chunks;
- the receiver checks exact size and SHA-256 again in Rust before an exclusive
  no-clobber save to `Downloads/Konofix Chat`;
- directly connected libp2p peers keep the existing streamed transfer path and its
  larger limit;
- relay operators cannot read private text/file content, but can observe IPs,
  identities, ciphertext sizes and timing and may retain ciphertext despite the
  ephemeral/expiration markers.

## Required physical test

Use the same exact 0.5.3 installer on both PCs, one on the home network and one on an
independent WAN/LTE network:

1. Confirm both users appear automatically in WORLD and exchange unique public text.
2. Open the speech-bubble action beside the remote relay participant and exchange
   unique private text in both directions.
3. Send a small text or image file below 2 MiB, accept it on the other PC, and compare
   the sender source file SHA-256 with the saved file SHA-256.
4. Repeat the file in the opposite direction.
5. Record the exact source commit, workflow run, installer SHA-256 and observed result.

Failure of any row blocks stable 0.5.3 publication. It does not invalidate the
already published 0.5.2 WORLD-text result.
