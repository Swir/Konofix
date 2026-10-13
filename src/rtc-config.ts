/**
 * Direct encrypted WebRTC routes. The former anonymous Open Relay hostname was
 * retired and now resolves to documentation/discard addresses, so retaining it
 * only delayed ICE while pretending that a TURN fallback existed. Do not add a
 * TURN service here until CI/runtime has real, time-limited credentials and a
 * relay-candidate preflight.
 */
export const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:stun.l.google.com:19302' },
  ],
  iceCandidatePoolSize: 1,
  iceTransportPolicy: 'all',
};
