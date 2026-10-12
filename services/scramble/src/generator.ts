import type { ScrambleBackend } from './backends.js';
import { GenerationTimeoutError, QueueFullError } from './errors.js';

interface Task {
  event: string;
  deadline: number;
  resolve: (scramble: string) => void;
  reject: (err: Error) => void;
}

export interface GeneratorOptions {
  timeoutMs: number;
  maxQueue: number;
}

interface EventTiming {
  count: number;
  totalMs: number;
  maxMs: number;
}

/**
 * A small queue in front of the scramble backend. cubing.js can only run one search at a time
 * per worker, so instead of piling promises onto it we queue them here, which makes the backlog
 * visible (_info.generator.queueDepth), enforces a deadline per scramble and sheds load when the
 * queue is full.
 */
export class ScrambleGenerator {
  private readonly queue: Task[] = [];
  private readonly idle: number[];
  private generated = 0;
  private failed = 0;
  private timeouts = 0;
  private rejected = 0;
  private readonly timings = new Map<string, EventTiming>();

  constructor(
    private readonly backend: ScrambleBackend,
    private readonly opts: GeneratorOptions,
  ) {
    this.idle = Array.from({ length: backend.size }, (_, i) => i);
  }

  get size(): number {
    return this.backend.size;
  }

  /** Scrambles waiting for a free worker. */
  get queueDepth(): number {
    return this.queue.length;
  }

  /** Scrambles currently being searched. */
  get active(): number {
    return this.backend.size - this.idle.length;
  }

  generate(event: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.queue.push({ event, deadline: Date.now() + this.opts.timeoutMs, resolve, reject });
      this.pump();
    });
  }

  /** Queues `count` scrambles at once; rejects immediately with QueueFullError when overloaded. */
  generateMany(event: string, count: number): Promise<string[]> {
    if (this.queueDepth + count > this.opts.maxQueue) {
      this.rejected += count;
      return Promise.reject(new QueueFullError());
    }
    return Promise.all(Array.from({ length: count }, () => this.generate(event)));
  }

  stats() {
    const perEvent: Record<string, { count: number; avgMs: number; maxMs: number }> = {};
    for (const [event, t] of this.timings) {
      perEvent[event] = { count: t.count, avgMs: Math.round(t.totalMs / t.count), maxMs: Math.round(t.maxMs) };
    }
    return {
      backend: this.backend.kind,
      workers: this.backend.size,
      queueDepth: this.queueDepth,
      active: this.active,
      generated: this.generated,
      failed: this.failed,
      timeouts: this.timeouts,
      rejected: this.rejected,
      perEvent,
    };
  }

  /** Rejects everything still queued (shutdown). */
  async close(): Promise<void> {
    for (const t of this.queue.splice(0)) t.reject(new Error('scramble generator shutting down'));
    await this.backend.close();
  }

  /** Starts queued tasks (FIFO) while slots are free. */
  private pump(): void {
    while (this.idle.length > 0 && this.queue.length > 0) {
      const task = this.queue.shift()!;
      const slot = this.idle.shift()!;
      void this.run(task, slot);
    }
  }

  private async run(task: Task, slot: number): Promise<void> {
    try {
      const remaining = task.deadline - Date.now();
      if (remaining <= 0) throw new GenerationTimeoutError('scramble timed out waiting in queue');
      const started = performance.now();
      const scramble = await this.backend.run(slot, task.event, remaining);
      this.record(task.event, performance.now() - started);
      task.resolve(scramble);
    } catch (err) {
      if (err instanceof GenerationTimeoutError) this.timeouts++;
      else this.failed++;
      task.reject(err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.idle.push(slot);
      this.pump();
    }
  }

  private record(event: string, ms: number) {
    this.generated++;
    const t = this.timings.get(event) ?? { count: 0, totalMs: 0, maxMs: 0 };
    t.count++;
    t.totalMs += ms;
    t.maxMs = Math.max(t.maxMs, ms);
    this.timings.set(event, t);
  }
}
