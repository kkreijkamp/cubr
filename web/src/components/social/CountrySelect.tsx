import { COUNTRIES } from './countries';

/**
 * Native (accessible, type-to-search) country picker. Its options are names alone: an option holds
 * only text, so no sprite flag, and an emoji flag in front kept typing "aus" from finding Australia
 * (and read as two letters on Windows). The form shows the chosen country's flag by its label.
 */
export function CountrySelect({ id, value, onChange }: { id?: string; value: string; onChange: (code: string) => void }) {
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">no country</option>
      {COUNTRIES.map((c) => (
        <option key={c.code} value={c.code}>
          {c.name}
        </option>
      ))}
    </select>
  );
}
