import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronRight, Search } from 'lucide-react';
import { closePalette, matches, openPalette, paletteStore, useAllCommands, type Command } from '../lib/commands';
import { applyVisualSettings } from '../lib/settings';
import { useStore } from '../lib/store';

interface Row {
  cmd: Command;
  /** display label, e.g. "Theme > dracula" in flattened search */
  label: string;
}

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

/** Global shortcuts: Esc (when not typing / timing), Ctrl/Cmd+K, Ctrl/Cmd+Shift+P. */
export function usePaletteHotkeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return; // e.g. the timer consumed Esc
      const mod = e.ctrlKey || e.metaKey;
      if ((mod && e.key.toLowerCase() === 'k') || (mod && e.shiftKey && e.key.toLowerCase() === 'p')) {
        e.preventDefault();
        if (paletteStore.get().open) closePalette();
        else openPalette();
        return;
      }
      if (e.key === 'Escape' && !paletteStore.get().open && !isTypingTarget(e.target) && !document.querySelector('.modal-backdrop')) {
        if (document.body.classList.contains('focus')) return;
        e.preventDefault();
        openPalette();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

export function CommandPalette() {
  const { open, initial } = useStore(paletteStore);
  if (!open) return null;
  return <PaletteInner initial={initial} />;
}

function PaletteInner({ initial }: { initial: string | null }) {
  const all = useAllCommands();
  const [stack, setStack] = useState<{ title: string; items: () => Command[] }[]>([]);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [previewing, setPreviewing] = useState(false);
  const previewed = useRef(false);
  const committed = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const centerNext = useRef(false);

  // open directly on a sub-list (e.g. footer theme button → "Theme…")
  useEffect(() => {
    if (!initial) return;
    const cmd = all.find((c) => c.id === initial);
    if (cmd?.children) setStack([{ title: cmd.label, items: cmd.children }]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);

  useEffect(() => {
    inputRef.current?.focus();
    return () => {
      // closing without choosing restores the saved theme/font after a live preview
      if (previewed.current && !committed.current) applyVisualSettings();
    };
  }, []);

  const rows: Row[] = useMemo(() => {
    const level = stack.length ? stack[stack.length - 1].items() : all;
    if (stack.length === 0 && query.trim()) {
      // single-list search: also search inside sub-lists ("Theme > dracula")
      const flat: Row[] = [];
      for (const c of level) {
        if (matches(c, query)) flat.push({ cmd: c, label: c.label });
        if (c.children) {
          for (const child of c.children()) {
            const label = `${c.label.replace(/…$/, '')} > ${child.label}`;
            if (matches({ ...child, label, keywords: [...(child.keywords ?? []), ...(c.keywords ?? [])] }, query)) flat.push({ cmd: child, label });
          }
        }
      }
      return flat.slice(0, 200);
    }
    return level.filter((c) => matches(c, query)).map((c) => ({ cmd: c, label: c.label }));
  }, [all, stack, query]);

  // a sub-list opens on its current choice (e.g. the active theme of ~180), like Monkeytype
  useEffect(() => {
    const current = stack.length && !query ? rows.findIndex((r) => r.cmd.active) : -1;
    setActive(Math.max(0, current));
    centerNext.current = current > 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, stack]);

  // live preview of the highlighted row (themes), after a short delay like Monkeytype
  const activeRow = rows[Math.min(active, rows.length - 1)];
  useEffect(() => {
    const cmd = activeRow?.cmd;
    setPreviewing(Boolean(cmd?.preview));
    if (!cmd?.preview) return;
    const t = setTimeout(() => {
      previewed.current = true;
      cmd.preview?.();
    }, 120);
    return () => clearTimeout(t);
  }, [activeRow]);

  useEffect(() => {
    listRef.current?.querySelector('.palette-row.active')?.scrollIntoView({ block: centerNext.current ? 'center' : 'nearest' });
    centerNext.current = false;
  }, [active]);

  const choose = (row: Row | undefined) => {
    if (!row) return;
    const { cmd } = row;
    if (cmd.children) {
      setStack((s) => [...s, { title: cmd.label, items: cmd.children! }]);
      setQuery('');
      return;
    }
    committed.current = true;
    const keepOpen = cmd.run?.() === false;
    if (!keepOpen) closePalette();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const n = rows.length;
    if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey) || (e.ctrlKey && (e.key === 'j' || e.key === 'n'))) {
      e.preventDefault();
      setActive((a) => (n ? (a + 1) % n : 0));
    } else if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey) || (e.ctrlKey && e.key === 'p')) {
      e.preventDefault();
      setActive((a) => (n ? (a - 1 + n) % n : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(rows[active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (stack.length) {
        setStack((s) => s.slice(0, -1));
        setQuery('');
      } else closePalette();
    } else if (e.key === 'Backspace' && !query && stack.length) {
      e.preventDefault();
      setStack((s) => s.slice(0, -1));
    }
  };

  const placeholder = stack.length ? stack[stack.length - 1].title : 'Search commands, themes, settings…';

  return createPortal(
    <div
      className={`modal-backdrop${previewing ? ' previewing' : ''}`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closePalette();
      }}
    >
      <div className="modal palette" role="dialog" aria-label="Command palette" onKeyDown={onKeyDown}>
        <div className="palette-input">
          <Search size={16} />
          <input ref={inputRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={placeholder} aria-label="Search commands" />
        </div>
        <div className="palette-list" ref={listRef}>
          {rows.length === 0 && <div className="palette-empty">No commands found</div>}
          {rows.map((row, i) => (
            <div
              key={`${row.cmd.id}-${i}`}
              className={`palette-row${i === active ? ' active' : ''}`}
              onMouseMove={() => i !== active && setActive(i)}
              onClick={() => choose(row)}
            >
              <span>{row.cmd.active ? <Check /> : row.cmd.icon ?? null}</span>
              <span>{row.label}</span>
              <span>{row.cmd.children ? <ChevronRight /> : null}</span>
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
