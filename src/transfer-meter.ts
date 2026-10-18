export class TransferMeter {
  private samples = new Map<string, { bytes: number; time: number; speed: number }>();
  observe(id: string, bytes: number, time = performance.now()): void {
    const previous = this.samples.get(id);
    if (!previous || bytes < previous.bytes) { this.samples.set(id, { bytes, time, speed: 0 }); return; }
    const elapsed = (time - previous.time) / 1000;
    if (elapsed < 0.5) return;
    this.samples.set(id, { bytes, time, speed: Math.max(0, (bytes - previous.bytes) / elapsed) });
    if (this.samples.size > 100) this.samples.delete(this.samples.keys().next().value!);
  }
  estimate(id: string, size: number, time = performance.now()): { speed: number; seconds?: number } {
    const sample = this.samples.get(id);
    if (!sample || time - sample.time > 5000 || sample.speed <= 0) return { speed: 0 };
    return { speed: sample.speed, seconds: Math.max(0, Math.ceil((size - sample.bytes) / sample.speed)) };
  }
}
