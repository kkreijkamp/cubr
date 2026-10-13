// Country options for the WCA rank calculator. Preferred source: GET /api/wca/countries (the WCA
// export's own list). Fallback: every valid ISO-3166 alpha-2 code, discovered at runtime through
// Intl.DisplayNames — no hard-coded list.
import { request } from '../../../lib/api';

export interface CountryOption {
  iso2: string;
  name: string;
}

let displayNames: Intl.DisplayNames | null = null;
try {
  displayNames = new Intl.DisplayNames(['en'], { type: 'region' });
} catch {
  displayNames = null;
}

/** "AU" → "Australia" (falls back to the code). */
export function countryName(iso2: string | null | undefined): string {
  if (!iso2) return '';
  try {
    return displayNames?.of(iso2.toUpperCase()) ?? iso2;
  } catch {
    return iso2;
  }
}

// macro-regions / pseudo codes Intl knows about that are not countries
const NOT_COUNTRIES = new Set(['EU', 'EZ', 'UN', 'ZZ', 'QO', 'XA', 'XB', 'AC', 'CP', 'DG', 'EA', 'IC', 'TA']);

function runtimeCountries(): CountryOption[] {
  if (!displayNames) return [];
  const out: CountryOption[] = [];
  for (let a = 65; a <= 90; a++) {
    for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b);
      if (NOT_COUNTRIES.has(code)) continue;
      let name: string | undefined;
      try {
        name = displayNames.of(code);
      } catch {
        name = undefined;
      }
      if (name && name !== code && !/region|unknown/i.test(name)) out.push({ iso2: code, name });
    }
  }
  return out.sort((x, y) => x.name.localeCompare(y.name));
}

let cached: Promise<CountryOption[]> | null = null;

/** Countries for the select, sorted by name. Never rejects. */
export function loadCountries(): Promise<CountryOption[]> {
  cached ??= request<{ countries: { id: string; iso2: string | null; name: string }[] }>('GET', '/api/wca/countries', undefined, { timeoutMs: 5000 })
    .then((r) => {
      const list = (r.countries ?? [])
        .filter((c) => c.iso2 && /^[A-Za-z]{2}$/.test(c.iso2))
        .map((c) => ({ iso2: c.iso2!.toUpperCase(), name: c.name || countryName(c.iso2) }))
        .sort((x, y) => x.name.localeCompare(y.name));
      if (!list.length) throw new Error('empty');
      return list;
    })
    .catch(() => {
      cached = null; // try the API again next time
      return runtimeCountries();
    });
  return cached;
}
