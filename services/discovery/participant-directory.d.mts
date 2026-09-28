// Type boundary for the browser-consumed, runtime-verified contact protocol.
declare const verifiedContact: unique symbol;
export type VerifiedContact = Readonly<{
  [verifiedContact]: true;
  schema: 1;
  origin: string;
  protocol: string;
  public_key: string;
  peer_id: string;
  ip: string;
  tcp_port: number;
  quic_port: number;
  issued_at: number;
  expires_at: number;
  sequence: number;
  signature: string;
}>;
export function canonicalOrigin(value: unknown): string;
export function leaseAddresses(record: VerifiedContact): string[];
