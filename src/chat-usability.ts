import { currentLocale, type Locale } from './i18n';

type TransferSnapshot = {
  transfer_id: string;
  peer_id: string;
  direction: string;
  size: number;
  transferred: number;
  progress: number;
  status: string;
};

const terminal = new Set(['completed', 'failed', 'rejected', 'cancelled']);
const phaseOrder: Record<string, number> = {
  requesting: 0, waiting: 1, sending: 2, receiving: 2, verifying: 3,
};

/** IPC replies are initial snapshots, not newer than already-delivered events. */
export function mergeTransferSnapshot<T extends TransferSnapshot>(
  previous: T | undefined,
  incoming: T,
  source: 'event' | 'reply',
): T {
  if (!previous) return incoming;
  if (previous.transfer_id !== incoming.transfer_id || previous.peer_id !== incoming.peer_id
      || previous.direction !== incoming.direction || previous.size !== incoming.size) return previous;
  if (source === 'reply' || terminal.has(previous.status)) return previous;
  if (!terminal.has(incoming.status)) {
    if (incoming.transferred < previous.transferred) return previous;
    if ((phaseOrder[incoming.status] ?? -1) < (phaseOrder[previous.status] ?? -1)) return previous;
  }
  return incoming;
}

export function transferPercent(transfer: Pick<TransferSnapshot, 'status' | 'progress'>): number {
  // Only an actual completion from the backend grants 100%, never a timer.
  if (transfer.status === 'completed') return 100;
  const progress = Number(transfer.progress);
  return Number.isFinite(progress) ? Math.max(0, Math.min(100, progress)) : 0;
}

const exitLabels: Record<Locale, string> = {
  en: 'Leave room', pl: 'Opuść pokój', no: 'Forlat rommet', de: 'Raum verlassen',
  fr: 'Quitter le salon', es: 'Salir de la sala', uk: 'Вийти з кімнати',
};
export const roomExitLabel = exitLabels[currentLocale] ?? exitLabels.en;
