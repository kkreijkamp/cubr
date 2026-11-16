import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// toast.ts keeps module state (the list and the id counter): a fresh copy per test
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

const load = async () => {
  const mod = await import('../toast');
  return { ...mod, messages: () => mod.toastStore.get().map((t) => t.message) };
};

describe('toasts', () => {
  it('shows the five most recent, newest last', async () => {
    const { toast, messages } = await load();
    for (let i = 1; i <= 7; i++) toast.notice(`n${i}`);
    expect(messages()).toEqual(['n3', 'n4', 'n5', 'n6', 'n7']);
  });

  it('closes an error after 6 s and other toasts after 3 s; one with duration 0 stays until dismissed', async () => {
    const { toast, dismissToast, messages } = await load();
    toast.error('e');
    toast.success('s');
    toast.pb('p');
    const keep = toast.notice('k', { durationMs: 0 });
    vi.advanceTimersByTime(2999);
    expect(messages()).toEqual(['e', 's', 'p', 'k']);
    vi.advanceTimersByTime(1);
    expect(messages()).toEqual(['e', 'k']);
    vi.advanceTimersByTime(3000);
    expect(messages()).toEqual(['k']);
    vi.advanceTimersByTime(600_000);
    expect(messages()).toEqual(['k']);
    dismissToast(keep);
    expect(messages()).toEqual([]);
  });

  it('honours a custom duration, and dismissing a toast early is harmless when its timer fires', async () => {
    const { toast, dismissToast, messages } = await load();
    const a = toast.notice('a', { durationMs: 10_000 });
    toast.notice('b');
    dismissToast(a);
    expect(messages()).toEqual(['b']);
    vi.advanceTimersByTime(10_000);
    expect(messages()).toEqual([]);
  });

  it('gives each type its title (or the one given), marks PBs important and keeps a click action', async () => {
    const { toast, toastStore } = await load();
    const onClick = vi.fn();
    const ids = [toast.pb('new pb'), toast.error('x', { title: 'import failed', onClick }), toast.success('ok'), toast.notice('fyi')];
    expect(toastStore.get().map(({ type, title, important }) => [type, title, important])).toEqual([
      ['pb', 'new personal best', true],
      ['error', 'import failed', false],
      ['success', 'success', false],
      ['notice', 'notice', false],
    ]);
    expect(toastStore.get()[1].onClick).toBe(onClick);
    expect('onClick' in toastStore.get()[2]).toBe(false);
    expect(new Set(ids).size).toBe(4);
    expect(toastStore.get().map((t) => t.id)).toEqual(ids);
  });
});
