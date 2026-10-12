import { isTauri } from '@tauri-apps/api/core';
import { check, type DownloadEvent, type Update } from '@tauri-apps/plugin-updater';

export type UpdateCheckResult = 'unsupported' | 'current' | 'declined' | 'installing';

export type UpdatePrompt = {
  currentVersion: string;
  version: string;
  notes?: string;
};

type UpdateCallbacks = {
  ask(update: UpdatePrompt): Promise<boolean> | boolean;
  onStatus?(status: 'checking' | 'downloading' | 'installing', percent?: number): void;
};

export function isStableVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+(?:\+[0-9A-Za-z.-]+)?$/.test(version.trim());
}

function progressPercent(event: DownloadEvent, state: { received: number; total?: number }): number | undefined {
  if (event.event === 'Started') {
    state.total = event.data.contentLength;
    state.received = 0;
  } else if (event.event === 'Progress') {
    state.received += event.data.chunkLength;
  }
  if (!state.total) return undefined;
  return Math.min(100, Math.round((state.received / state.total) * 100));
}

export async function checkForStableUpdate(callbacks: UpdateCallbacks): Promise<UpdateCheckResult> {
  if (!isTauri()) return 'unsupported';
  callbacks.onStatus?.('checking');
  let update: Update | null = null;
  try {
    update = await check({ timeout: 15_000 });
    if (!update) return 'current';
    // Defense in depth: the endpoint is GitHub's latest non-prerelease release,
    // and the client independently refuses prerelease SemVer identifiers.
    if (!isStableVersion(update.version)) {
      await update.close();
      return 'current';
    }
    const accepted = await callbacks.ask({
      currentVersion: update.currentVersion,
      version: update.version,
      notes: update.body,
    });
    if (!accepted) {
      await update.close();
      return 'declined';
    }

    const progress = { received: 0, total: undefined as number | undefined };
    await update.downloadAndInstall(event => {
      const percent = progressPercent(event, progress);
      callbacks.onStatus?.(event.event === 'Finished' ? 'installing' : 'downloading', percent);
    }, { timeout: 10 * 60_000, restartAfterInstall: true });
    return 'installing';
  } catch (error) {
    if (update) {
      try { await update.close(); } catch {}
    }
    throw error;
  }
}
