import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Download, FileUp, LogOut, Pencil, Upload, UserCog } from 'lucide-react';
import { CsTimerFormatError, parseCsTimerExport, type ImportedSession } from '@cubetype/cubestats';
import { downloadFile, eventLabel, friendlyError, plural } from './util';
import { useAuth } from '../../lib/auth';
import { useRegisterCommands } from '../../lib/commands';
import { formatDate, formatNumber, localDateKey } from '../../lib/format';
import { exportAll, importSessions } from '../../lib/solves';
import { toast } from '../../lib/toast';
import type { PrivateUser } from '../../lib/types';
import { Modal } from '../Modal';
import { Spinner } from '../Spinner';

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_SOLVES = 100_000;

/** csTimer's parser messages are technical; explain what to do instead. */
function importErrorMessage(err: unknown): string {
  if (err instanceof CsTimerFormatError) {
    if (/valid JSON/i.test(err.message)) return 'this file is not a csTimer export. in csTimer open export → "export to file" and pick that .txt file.';
    if (/no session/i.test(err.message)) return 'no csTimer sessions found in this file.';
    return `this file could not be read as a csTimer export (${err.message.toLowerCase()}).`;
  }
  return friendlyError(err, 'the importer');
}

function dateRange(s: ImportedSession): string {
  const times = s.solves.map((x) => Date.parse(x.createdAt)).filter((t) => t > 86_400_000);
  if (times.length === 0) return '-';
  const a = formatDate(new Date(Math.min(...times)).toISOString());
  const b = formatDate(new Date(Math.max(...times)).toISOString());
  return a === b ? a : `${a} – ${b}`;
}

function ImportPreview({ fileName, sessions, onClose }: { fileName: string; sessions: ImportedSession[]; onClose: () => void }) {
  const [selected, setSelected] = useState<Set<number>>(() => new Set(sessions.map((_, i) => i)));
  const [busy, setBusy] = useState(false);
  const chosen = useMemo(() => sessions.filter((_, i) => selected.has(i)), [sessions, selected]);
  const solveCount = chosen.reduce((a, s) => a + s.solves.length, 0);
  const tooMany = solveCount > MAX_SOLVES;

  const toggle = (i: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  const confirm = async () => {
    if (!chosen.length || busy || tooMany) return;
    setBusy(true);
    try {
      const res = await importSessions(chosen);
      toast.success(`imported ${plural(res.sessions, 'session')} · ${plural(res.solves, 'solve')}`, { title: 'csTimer import', durationMs: 5000 });
      onClose();
    } catch (err) {
      toast.error(friendlyError(err, 'the solve service'), { title: 'import failed' });
      setBusy(false);
    }
  };

  return (
    <Modal title="import from csTimer" onClose={busy ? () => undefined : onClose} wide>
      <div className="im-summary">
        <div className="stat">
          <span className="label">file</span>
          <span className="value text" style={{ fontSize: '1rem', whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
            {fileName}
          </span>
        </div>
        <div className="stat">
          <span className="label">sessions</span>
          <span className="value">{chosen.length}</span>
        </div>
        <div className="stat">
          <span className="label">solves</span>
          <span className="value">{formatNumber(solveCount)}</span>
        </div>
      </div>
      <div className="im-list">
        <table className="table im-table">
          <thead>
            <tr>
              <th className="left">session</th>
              <th className="left">event</th>
              <th>solves</th>
              <th className="hide-mobile-cell">dates</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s, i) => (
              <tr key={i} className={selected.has(i) ? undefined : 'off'}>
                <td className="left">
                  <label>
                    <input type="checkbox" checked={selected.has(i)} onChange={() => toggle(i)} disabled={busy} />
                    <span title={s.name}>{s.name}</span>
                  </label>
                </td>
                <td className="left">{eventLabel(s.event)}</td>
                <td>{formatNumber(s.solves.length)}</td>
                <td className="secondary hide-mobile-cell">{dateRange(s)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {tooMany && <div className="error small">one import can hold at most {formatNumber(MAX_SOLVES)} solves — untick a few sessions.</div>}
      <div className="sub small">non-wca scramble types are mapped to the closest event. dates, penalties, scrambles and comments are kept.</div>
      <div className="im-actions">
        <button className="btn" onClick={onClose} disabled={busy}>
          cancel
        </button>
        <button className="btn primary" onClick={confirm} disabled={!chosen.length || busy || tooMany}>
          {busy ? <Spinner size={16} /> : <Upload />} import {plural(solveCount, 'solve')}
        </button>
      </div>
    </Modal>
  );
}

/** Account-only section: csTimer import, JSON export, profile + logout. */
export function AccountSection({ user, onEdit }: { user: PrivateUser; onEdit: () => void }) {
  const { logout } = useAuth();
  const navigate = useNavigate();
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<{ fileName: string; sessions: ImportedSession[] } | null>(null);
  const [reading, setReading] = useState(false);
  const [exporting, setExporting] = useState(false);

  const pickFile = () => fileRef.current?.click();

  const onFile = async (file: File | undefined) => {
    if (fileRef.current) fileRef.current.value = '';
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      toast.error('that file is larger than 25 mb.', { title: 'import failed' });
      return;
    }
    setReading(true);
    try {
      const sessions = parseCsTimerExport(await file.text());
      if (sessions.length === 0) throw new CsTimerFormatError('no session data found');
      setPreview({ fileName: file.name, sessions });
    } catch (err) {
      toast.error(importErrorMessage(err), { title: 'import failed' });
    } finally {
      setReading(false);
    }
  };

  const doExport = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const data = await exportAll();
      const solves = data.sessions.reduce((a, s) => a + s.solves.length, 0);
      downloadFile(`cubetype-export-${localDateKey()}.json`, JSON.stringify(data, null, solves > 20_000 ? undefined : 2));
      toast.success(`exported ${plural(data.sessions.length, 'session')} · ${plural(solves, 'solve')}`);
    } catch (err) {
      toast.error(friendlyError(err, 'the solve service'), { title: 'export failed' });
    } finally {
      setExporting(false);
    }
  };

  const doLogout = async () => {
    await logout();
    toast.notice('you have been signed out', { title: 'signed out' });
    navigate('/');
  };

  useRegisterCommands(
    'account',
    () => [
      { id: 'account-edit', label: 'Edit profile', icon: <Pencil />, run: onEdit },
      { id: 'account-import', label: 'Import csTimer data…', icon: <FileUp />, keywords: ['cstimer', 'upload'], run: pickFile },
      { id: 'account-export', label: 'Export data (json)', icon: <Download />, keywords: ['backup', 'download'], run: () => void doExport() },
    ],
    [onEdit],
  );

  return (
    <section className="pv-card" aria-label="account and data">
      <div className="pv-card-head" style={{ marginBottom: 0 }}>
        <h2 className="pv-title">
          <UserCog /> account &amp; data
        </h2>
      </div>
      <div className="ac-rows">
        <div className="ac-row">
          <div>
            <div className="t">
              <FileUp /> import from csTimer
            </div>
            <div className="d">
              in csTimer open <span className="text">export → export to file</span>, then pick that .txt here. you will see a preview before anything is
              imported.
            </div>
          </div>
          <div className="ac-actions">
            <input ref={fileRef} type="file" accept=".txt,.json,text/plain,application/json" hidden onChange={(e) => void onFile(e.target.files?.[0])} />
            <button className="btn" onClick={pickFile} disabled={reading}>
              {reading ? <Spinner size={16} /> : <Upload />} choose file
            </button>
          </div>
        </div>
        <div className="ac-row">
          <div>
            <div className="t">
              <Download /> export
            </div>
            <div className="d">download every session and solve as json — your data is yours.</div>
          </div>
          <div className="ac-actions">
            <button className="btn" onClick={doExport} disabled={exporting}>
              {exporting ? <Spinner size={16} /> : <Download />} export json
            </button>
          </div>
        </div>
        <div className="ac-row">
          <div>
            <div className="t">
              <UserCog /> account
            </div>
            <div className="d">
              signed in as <span className="text">{user.username}</span> · {user.email}
            </div>
          </div>
          <div className="ac-actions">
            <button className="btn" onClick={onEdit}>
              <Pencil /> edit profile
            </button>
            <button className="btn danger-text" onClick={doLogout}>
              <LogOut /> log out
            </button>
          </div>
        </div>
      </div>
      {preview && <ImportPreview fileName={preview.fileName} sessions={preview.sessions} onClose={() => setPreview(null)} />}
    </section>
  );
}
