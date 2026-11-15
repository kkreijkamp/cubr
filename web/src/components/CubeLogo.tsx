/** cubr logo mark: a 3x3 face whose centre sticker uses the text colour. */
export function CubeLogo({ className }: { className?: string }) {
  const cells = [0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => ({ r, c })));
  return (
    <svg className={className} viewBox="0 0 26 26" aria-hidden="true">
      {cells.map(({ r, c }) => (
        <rect
          key={`${r}${c}`}
          x={1 + c * 8.25}
          y={1 + r * 8.25}
          width="7.25"
          height="7.25"
          rx="1.8"
          fill={r === 1 && c === 1 ? 'var(--text-color)' : 'currentColor'}
        />
      ))}
    </svg>
  );
}
