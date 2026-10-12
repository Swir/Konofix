/**
 * Prefer a direct peer-to-peer path, but keep an encrypted TURN route for
 * symmetric NAT, LTE and restrictive firewalls. TURN only forwards DTLS/SRTP
 * and DataChannel ciphertext; it cannot read chat files or audio.
 *
 * Open Relay publishes these shared credentials for public WebRTC projects.
 * Keeping STUN first lets ICE choose the cheaper direct path whenever it works.
 */
export const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:stun.l.google.com:19302' },
    {
      urls: [
        'turn:openrelay.metered.ca:80?transport=udp',
        'turn:openrelay.metered.ca:80?transport=tcp',
        'turn:openrelay.metered.ca:443?transport=udp',
        'turn:openrelay.metered.ca:443?transport=tcp',
        'turns:openrelay.metered.ca:443?transport=tcp',
      ],
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
  ],
  iceCandidatePoolSize: 8,
  iceTransportPolicy: 'all',
};
