import type { VerifiedContact } from './participant-directory.mjs';
export type ContactFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Pick<Response, 'ok' | 'headers' | 'body'> & Partial<Pick<Response, 'status'>>>;
export function exchangeContact(origin: string, options?: {
  registration?: Uint8Array | null;
  fetchImpl?: ContactFetch;
  now?: () => number;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<VerifiedContact[]>;
