type UiModule = {
  name: string;
  load: () => Promise<unknown>;
};

const modules: UiModule[] = [
  { name: 'secure-ui', load: () => import('./secure-ui') },
  { name: 'private-audio-ui', load: () => import('./private-audio-ui') },
  { name: 'room-audio-ui', load: () => import('./room-audio-ui') },
  { name: 'voice-mute-ui', load: () => import('./voice-mute-ui') },
  { name: 'test-updater-ui', load: () => import('./test-updater-ui') },
];

function reportModuleError(name: string, error: unknown): void {
  const message = error instanceof Error ? (error.stack || error.message) : String(error);
  console.error(`Konofix optional UI module failed: ${name}`, error);
  window.dispatchEvent(new CustomEvent('konofix-module-error', {
    detail: { module: name, error: message.slice(0, 3000) },
  }));
}

function afterFirstPaint(): Promise<void> {
  return new Promise(resolve => {
    requestAnimationFrame(() => window.setTimeout(resolve, 0));
  });
}

async function startOptionalUi(): Promise<void> {
  await afterFirstPaint();
  for (const module of modules) {
    try {
      await module.load();
    } catch (error) {
      reportModuleError(module.name, error);
    }
  }
}

void startOptionalUi();
