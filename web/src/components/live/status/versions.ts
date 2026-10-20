import { compareVersions, type ServiceView } from './monitor';

/** Number of distinct version colours (vc0...vc4 in status.css, derived from theme tokens). */
const PALETTE_SIZE = 5;

export interface VersionLegendItem {
  version: string;
  cls: string;
  services: string[];
  pods: number;
}

/**
 * Assigns each version seen anywhere in the cluster a colour class: the newest version gets the
 * theme's main colour (so a rollout "lights up"), older ones text / error-extra / ... colours.
 */
export function versionColors(services: ServiceView[]): { cls: (v: string) => string; legend: VersionLegendItem[] } {
  const byVersion = new Map<string, { services: Set<string>; pods: number }>();
  for (const s of services) {
    for (const v of s.versions) {
      if (!byVersion.has(v)) byVersion.set(v, { services: new Set(), pods: 0 });
      byVersion.get(v)!.services.add(s.name);
    }
    for (const p of s.pods) {
      if (!byVersion.has(p.version)) byVersion.set(p.version, { services: new Set([s.name]), pods: 0 });
      if (!p.stale) byVersion.get(p.version)!.pods++;
    }
  }
  const sorted = [...byVersion.keys()].sort((a, b) => compareVersions(b, a));
  const index = new Map(sorted.map((v, i) => [v, Math.min(i, PALETTE_SIZE - 1)]));
  const cls = (v: string) => `vc${index.get(v) ?? PALETTE_SIZE - 1}`;
  const legend = sorted.map((v) => ({ version: v, cls: cls(v), services: [...byVersion.get(v)!.services], pods: byVersion.get(v)!.pods }));
  return { cls, legend };
}
