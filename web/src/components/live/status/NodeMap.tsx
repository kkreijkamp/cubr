import { Server } from 'lucide-react';
import { vlabel, type ServiceView } from './monitor';
import { podParts } from './ServiceCard';

/** Which pods run on which node (from `_info.node`) — topology spread, node drains, rescheduling. */
export function NodeMap({ services, vc }: { services: ServiceView[]; vc: (v: string) => string }) {
  const nodes = new Map<string, { service: string; pod: string; version: string; stale: boolean; fresh: boolean }[]>();
  for (const s of services) {
    for (const p of s.pods) {
      const list = nodes.get(p.node) ?? [];
      list.push({ service: s.name, pod: p.pod, version: p.version, stale: p.stale, fresh: p.fresh });
      nodes.set(p.node, list);
    }
  }
  const sorted = [...nodes.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  return (
    <section className="card status-panel" aria-labelledby="nodes-title">
      <div className="live-section-title">
        <h3 className="h3" id="nodes-title">
          <Server /> nodes
        </h3>
        <span className="meta">
          {sorted.length} node{sorted.length === 1 ? '' : 's'} · from _info.node
        </span>
      </div>
      {sorted.length === 0 ? (
        <div className="panel-empty">no pod has answered yet.</div>
      ) : (
        <div className="node-map">
          {sorted.map(([node, pods]) => (
            <div key={node} className="node-card">
              <div className="node-name" title={node}>
                {node}
                <span className="count">{pods.filter((p) => !p.stale).length}</span>
              </div>
              <div className="node-pods">
                {pods.map((p) => (
                  <span
                    key={`${p.service}|${p.pod}`}
                    className={`node-pod ${vc(p.version)}${p.stale ? ' stale' : ''}${p.fresh ? ' fresh' : ''}`}
                    title={`${p.pod} · ${vlabel(p.version)}`}
                  >
                    <span className="vsq" aria-hidden="true" />
                    {p.service}
                    <span className="id">·{podParts(p.pod, p.service).id}</span>
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
