// WCA rankings: "where would I rank?" calculator, world records, competitor search + detail.
// State lives in the URL (?tab=rank&event=333&kind=single&t=12.34&country=AU / ?tab=people&person=ID)
// so results are shareable and other pages can deep-link (e.g. /wca?person=2009ZEMD01).
import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { GlobeAltIcon, MagnifyingGlassIcon, StarIcon, UsersIcon } from '@heroicons/react/24/outline';
import { EVENTS } from '@cubr/cubestats';
import { api } from '../lib/api';
import { formatDate } from '../lib/format';
import { useRegisterCommands } from '../lib/commands';
import { useAsync } from '../lib/useAsync';
import { useCanonical } from '../lib/canonical';
import { PAGE_META } from '../lib/pageMeta';
import { usePageMeta } from '../lib/usePageMeta';
import { Segmented } from '../components/live/ui';
import { PeopleSearch, PersonCard, RankCalculator, RecordsTable, type RankParams } from '../components/live/wca/WcaParts';
import '../components/live/live.css';
import '../components/live/wca/wca.css';

type Tab = 'rank' | 'records' | 'people';
const TABS: { value: Tab; label: string }[] = [
  { value: 'rank', label: 'where would I rank?' },
  { value: 'records', label: 'records' },
  { value: 'people', label: 'people' },
];
const EVENT_IDS = new Set(EVENTS.map((e) => e.id));

function Citation() {
  const meta = useAsync((signal) => api.wca.meta(signal), []);
  return (
    <p className="wca-citation">
      This information is based on competition results owned and maintained by the World Cube Association, published at{' '}
      <a href="https://www.worldcubeassociation.org/results" target="_blank" rel="noreferrer">
        worldcubeassociation.org/results
      </a>{' '}
      as of {meta.data?.exportDate ? formatDate(meta.data.exportDate) : meta.error ? 'the last import' : '...'}.
      {meta.data?.counts?.persons ? ` ${meta.data.counts.persons.toLocaleString('en-US')} competitors - ${(meta.data.counts.competitions ?? 0).toLocaleString('en-US')} competitions.` : ''}
    </p>
  );
}

export default function WcaPage() {
  useCanonical('/wca');
  usePageMeta(PAGE_META['/wca']);
  const [sp, setSp] = useSearchParams();
  const person = sp.get('person');
  const rawTab = sp.get('tab');
  const tab: Tab = person ? 'people' : rawTab === 'records' || rawTab === 'people' ? rawTab : 'rank';
  const ev = sp.get('event');
  const rankParams: RankParams = {
    event: ev && EVENT_IDS.has(ev) ? ev : '333',
    kind: sp.get('kind') === 'average' ? 'average' : 'single',
    t: sp.get('t') ?? '',
    country: (sp.get('country') ?? '').toUpperCase(),
  };

  const update = useCallback(
    (patch: Record<string, string | null>) => {
      setSp(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(patch)) {
            if (v === null || v === '') next.delete(k);
            else next.set(k, v);
          }
          return next;
        },
        { replace: true },
      );
    },
    [setSp],
  );

  const setTab = (t: Tab) => update({ tab: t === 'rank' ? null : t, person: null });
  const openPerson = (id: string) => {
    setSp(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set('tab', 'people');
        next.set('person', id);
        return next;
      },
      { replace: false },
    );
    window.scrollTo({ top: 0 });
  };

  useRegisterCommands(
    'wca',
    () => [
      { id: 'wca-rank', label: 'WCA: where would I rank?', icon: <StarIcon />, run: () => setTab('rank') },
      { id: 'wca-records', label: 'WCA: world records', icon: <GlobeAltIcon />, run: () => setTab('records') },
      { id: 'wca-people', label: 'WCA: search competitors', icon: <MagnifyingGlassIcon />, run: () => setTab('people') },
    ],
    [],
  );

  return (
    <div className="stack lg wca-page live-page">
      <div className="live-head">
        <div className="titles">
          <h1 className="h2">
            <GlobeAltIcon /> {PAGE_META['/wca'].heading}
          </h1>
          <div className="subtitle">official World Cube Association results - see how your times compare with every competitor.</div>
        </div>
        <Segmented label="section" value={tab} onChange={setTab} options={TABS} />
      </div>

      {/* data-nosnippet: search results quote the heading and the line under it, or the page's description,
          never the event and country lists ("🇦🇫 Afghanistan 🇦🇱 Albania ..."); display: contents keeps the layout */}
      <div data-nosnippet style={{ display: 'contents' }}>
        {tab === 'rank' && (
          <RankCalculator
            params={rankParams}
            onChange={(p) =>
              update({
                ...(p.event !== undefined ? { event: p.event === '333' ? null : p.event } : {}),
                ...(p.kind !== undefined ? { kind: p.kind === 'single' ? null : p.kind } : {}),
                ...(p.t !== undefined ? { t: p.t } : {}),
                ...(p.country !== undefined ? { country: p.country } : {}),
              })
            }
            onPerson={openPerson}
          />
        )}
        {tab === 'records' && (
          <section aria-label="world records">
            <RecordsTable onPerson={openPerson} />
          </section>
        )}
        {tab === 'people' &&
          (person ? (
            <PersonCard wcaId={person} onBack={() => update({ person: null })} />
          ) : (
            <section aria-label="people search" className="stack">
              <div className="h3" style={{ margin: 0 }}>
                <UsersIcon /> competitors
              </div>
              <PeopleSearch initialQuery={sp.get('q') ?? ''} onQuery={(q) => update({ q })} onPerson={openPerson} />
            </section>
          ))}
      </div>

      <Citation />
    </div>
  );
}
