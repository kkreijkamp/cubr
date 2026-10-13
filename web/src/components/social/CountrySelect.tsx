import { COUNTRIES } from './countries';
import { flagEmoji } from '../../lib/format';

/** Native (accessible, type-to-search) country picker with flag emojis. */
export function CountrySelect({ id, value, onChange }: { id?: string; value: string; onChange: (code: string) => void }) {
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">no country</option>
      {COUNTRIES.map((c) => (
        <option key={c.code} value={c.code}>
          {flagEmoji(c.code)} {c.name}
        </option>
      ))}
    </select>
  );
}
