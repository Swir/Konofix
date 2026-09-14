declare module '@tauri-apps/api/core' {
  export function invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T>;
}

declare module '@tauri-apps/api/event' {
  export type Event<T> = { payload: T };
  export function listen<T>(event: string, handler: (event: Event<T>) => void): Promise<() => void>;
}
