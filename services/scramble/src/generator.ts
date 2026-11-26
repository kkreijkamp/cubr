import type { ScrambleBackend } from './backends.js';
import { GenerationTimeoutError, QueueFullError } from './errors.js';
import { jobLabel } from './practice.js';

/** User-facing work always runs before background pool refills. */
export type Priority = 'request' | 'refill';

interface Task {
  event: string;
  priority: Priority;
  /** Pin to one backend slot (warm-up uses this so every pool thread initialises its tables). */
  slot?: number;
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
 * A small priority queue in front of the scramble backend. cubing.js can only run one search at
 * a time per worker, so instead of piling promises onto it we queue them here, which makes the
 * backlog visible (_info.generator.queueDepth), lets requests overtake background refills,
 * enforces a deadline per scramble and sheds load when the queue is full.
 */
export class ScrambleGenerator {
  private readonly queues: Record<Priority, Task[]> = { request: [], refill: [] };
  private readonly idle: number[];
  private activeRequests = 0;
  private lastRequestDoneAt = 0;
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
    return this.queues.request.length + this.queues.refill.length;
  }

  /** Scrambles currently being searched. */
  get active(): number {
    return this.backend.size - this.idle.length;
  }

  /** True while user requests are queued/running (or finished < graceMs ago) -> refill backs off. */
  isBusy(graceMs = 1000): boolean {
    return this.queues.request.length > 0 || this.activeRequests > 0 || Date.now() - this.lastRequestDoneAt < graceMs;
  }

  generate(event: string, priority: Priority = 'request', slot?: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.queues[priority].push({ event, priority, slot, deadline: Date.now() + this.opts.timeoutMs, resolve, reject });
      this.pump();
    });
  }

  /** Queues `count` scrambles at once; rejects immediately with QueueFullError when overloaded. */
  generateMany(event: string, count: number, priority: Priority = 'request'): Promise<string[]> {
    if (this.queueDepth + count > this.opts.maxQueue) {
      this.rejected += count;
      return Promise.reject(new QueueFullError());
    }
    return Promise.all(Array.from({ length: count }, () => this.generate(event, priority)));
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
      queuedRequests: this.queues.request.length,
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
    for (const q of Object.values(this.queues)) {
      for (const t of q.splice(0)) t.reject(new Error('scramble generator shutting down'));
    }
    await this.backend.close();
  }

  /** Starts queued tasks while slots are free. Requests first, then refills, FIFO within each. */
  private pump(): void {
    while (this.idle.length > 0) {
      const next = this.takeNext();
      if (!next) return;
      void this.run(next.task, next.slot);
    }
  }

  private takeNext(): { task: Task; slot: number } | null {
    for (const queue of [this.queues.request, this.queues.refill]) {
      for (let i = 0; i < queue.length; i++) {
        const task = queue[i];
        const slot = task.slot === undefined ? this.idle[0] : task.slot;
        const idleIndex = this.idle.indexOf(slot);
        if (idleIndex === -1) continue; // pinned to a busy slot
        queue.splice(i, 1);
        this.idle.splice(idleIndex, 1);
        return { task, slot };
      }
    }
    return null;
  }

  private async run(task: Task, slot: number): Promise<void> {
    const isRequest = task.priority === 'request';
    if (isRequest) this.activeRequests++;
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
      if (isRequest) {
        this.activeRequests--;
        this.lastRequestDoneAt = Date.now();
      }
      this.idle.push(slot);
      this.pump();
    }
  }

  private record(job: string, ms: number) {
    this.generated++;
    const event = jobLabel(job); // practice jobs are timed together per puzzle, not per state
    const t = this.timings.get(event) ?? { count: 0, totalMs: 0, maxMs: 0 };
    t.count++;
    t.totalMs += ms;
    t.maxMs = Math.max(t.maxMs, ms);
    this.timings.set(event, t);
  }
}
