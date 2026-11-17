import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowDownTrayIcon,
  ArrowRightStartOnRectangleIcon,
  ArrowUpTrayIcon,
  DocumentArrowUpIcon,
  EnvelopeIcon,
  PencilIcon,
  UserCircleIcon,
} from '@heroicons/react/24/outline';
import { parseTimerFile, toCsTimerExport, TimerFormatError, type ImportedSession, type TimerImport } from '@cubr/cubestats';
import { csTimerFileName, downloadFile, eventLabel, friendlyError, plural, skippedNotes } from './util';
import { Section } from './Widget';
import { useAuth } from '../../lib/auth';
import { useRegisterCommands } from '../../lib/commands';
import { formatDate, formatNumber, localDateKey } from '../../lib/format';
import { exportAll, importSessions } from '../../lib/solves';
import { toast } from '../../lib/toast';
import type { PrivateUser } from '../../lib/types';
import { Modal } from '../Modal';
import { SignInMethods } from './SignInMethods';
import { ChangeEmailModal } from './ChangeEmailModal';
import { SessionName } from '../SessionName';
import { Spinner } from '../Spinner';

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_SOLVES = 100_000;

/** The importer's messages already say what is wrong (and which formats work). */
function importErrorMessage(err: unknown): string {
  if (err instanceof TimerFormatError) return err.message.charAt(0).toLowerCase() + err.message.slice(1);
  return friendlyError(err, 'the importer');
}

function dateRange(s: ImportedSession): string {
  const times = s.solves.map((x) => Date.parse(x.createdAt)).filter((t) => t > 86_400_000);
  if (times.length === 0) return '-';
  const a = formatDate(new Date(Math.min(...times)).toISOString());
  const b = formatDate(new Date(Math.max(...times)).toISOString());
  return a === b ? a : `${a} - ${b}`;
}

function ImportPreview({ fileName, parsed, onClose }: { fileName: string; parsed: TimerImport; onClose: () => void }) {
  const { format, sessions, skipped } = parsed;
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
      toast.success(`imported ${plural(res.sessions, 'session')} - ${plural(res.solves, 'solve')}`, { title: `${format} import`, durationMs: 5000 });
      onClose();
    } catch (err) {
      toast.error(friendlyError(err, 'the solve service'), { title: 'import failed' });
      setBusy(false);
    }
  };

  return (
    <Modal title="import solves" onClose={busy ? () => undefined : onClose} wide>
      <div className="im-summary">
        <div className="stat">
          <span className="label">file</span>
          <span className="value text" style={{ fontSize: '1rem', whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
            {fileName}
          </span>
        </div>
        <div className="stat">
          <span className="label">format</span>
          <span className="value text" style={{ fontSize: '1rem' }}>
            {format}
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
                    <SessionName name={s.name} practice={s.practice} title={s.name} />
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
      {tooMany && <div className="error small">one import can hold at most {formatNumber(MAX_SOLVES)} solves - untick a few sessions.</div>}
      {skippedNotes(skipped).map((note) => (
        <div key={note} className="sub small">
          {note}
        </div>
      ))}
      <div className="sub small">non-wca puzzle types are mapped to the closest event. dates, penalties, scrambles and comments are kept.</div>
      <div className="im-actions">
        <button className="btn" onClick={onClose} disabled={busy}>
          cancel
        </button>
        <button className="btn primary" onClick={confirm} disabled={!chosen.length || busy || tooMany}>
          {busy ? <Spinner size={16} /> : <ArrowUpTrayIcon />} import {plural(solveCount, 'solve')}
        </button>
      </div>
    </Modal>
  );
}

/** Account-only section: import (cubr and every format csTimer imports), JSON and csTimer export, profile + logout. */
export function AccountSection({ user, onEdit }: { user: PrivateUser; onEdit: () => void }) {
  const { logout } = useAuth();
  const navigate = useNavigate();
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<{ fileName: string; parsed: TimerImport } | null>(null);
  const [reading, setReading] = useState(false);
  const [exporting, setExporting] = useState<'json' | 'cstimer' | null>(null);
  const [changingEmail, setChangingEmail] = useState(false);
  // the address a confirmation link went to, until the page reloads
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);

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
      // bytes, not text: DCTimer backups are SQLite files
      const parsed = parseTimerFile(new Uint8Array(await file.arrayBuffer()));
      setPreview({ fileName: file.name, parsed });
    } catch (err) {
      toast.error(importErrorMessage(err), { title: 'import failed' });
    } finally {
      setReading(false);
    }
  };

  const doExport = async (format: 'json' | 'cstimer') => {
    if (exporting) return;
    setExporting(format);
    try {
      const data = await exportAll();
      const solves = data.sessions.reduce((a, s) => a + s.solves.length, 0);
      if (format === 'json') downloadFile(`cubr-export-${localDateKey()}.json`, JSON.stringify(data, null, solves > 20_000 ? undefined : 2));
      else downloadFile(csTimerFileName(), toCsTimerExport(data.sessions), 'text/plain');
      toast.success(`exported ${plural(data.sessions.length, 'session')} - ${plural(solves, 'solve')}`);
    } catch (err) {
      toast.error(friendlyError(err, 'the solve service'), { title: 'export failed' });
    } finally {
      setExporting(null);
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
      { id: 'account-edit', label: 'Edit profile', icon: <PencilIcon />, run: onEdit },
      { id: 'account-import', label: 'Import solves...', icon: <DocumentArrowUpIcon />, keywords: ['cstimer', 'twisty', 'cubedesk', 'block keeper', 'upload', 'restore'], run: pickFile },
      { id: 'account-export', label: 'Export data (json)', icon: <ArrowDownTrayIcon />, keywords: ['backup', 'download'], run: () => void doExport('json') },
      { id: 'account-export-cstimer', label: 'Export for csTimer', icon: <ArrowDownTrayIcon />, keywords: ['cstimer', 'backup', 'download'], run: () => void doExport('cstimer') },
      { id: 'account-email', label: 'Change email...', icon: <EnvelopeIcon />, keywords: ['address', 'account'], run: () => setChangingEmail(true) },
    ],
    [onEdit],
  );

  return (
    <Section label="account and data" className="pf-account" title="account & data">
      <div className="ac-rows">
        <div className="ac-row">
          <div>
            <div className="t">
              <DocumentArrowUpIcon /> import solves
            </div>
            <div className="d">
              a cubr export, or any file csTimer can import: csTimer (<span className="text">export -&gt; export to file</span>), Twisty Timer, Cubic Timer,
              Block Keeper, CubeDesk, DCTimer, mateus Cubetimer or GAN CubeStation. you will see a preview before anything is imported.
            </div>
          </div>
          <div className="ac-actions">
            <input ref={fileRef} type="file" hidden onChange={(e) => void onFile(e.target.files?.[0])} />
            <button className="btn" onClick={pickFile} disabled={reading}>
              {reading ? <Spinner size={16} /> : <ArrowUpTrayIcon />} choose file
            </button>
          </div>
        </div>
        <div className="ac-row">
          <div>
            <div className="t">
              <ArrowDownTrayIcon /> export
            </div>
            <div className="d">
              every session and solve. json re-imports here or on another cubr server; the csTimer file goes into csTimer with{' '}
              <span className="text">export -&gt; import session(s) from other timers</span>, which adds sessions without replacing yours.
            </div>
          </div>
          <div className="ac-actions">
            <button className="btn" onClick={() => void doExport('json')} disabled={exporting !== null}>
              {exporting === 'json' ? <Spinner size={16} /> : <ArrowDownTrayIcon />} export json
            </button>
            <button className="btn" onClick={() => void doExport('cstimer')} disabled={exporting !== null}>
              {exporting === 'cstimer' ? <Spinner size={16} /> : <ArrowDownTrayIcon />} export for csTimer
            </button>
          </div>
        </div>
        <SignInMethods />
        <div className="ac-row">
          <div>
            <div className="t">
              <EnvelopeIcon /> email
            </div>
            <div className="d">
              <span className="text">{user.email}</span>. password-reset links and notices about your account go here.
              {pendingEmail && pendingEmail.toLowerCase() !== user.email.toLowerCase() && (
                <>
                  {' '}
                  <span className="main">waiting for you to confirm {pendingEmail}</span>: open the link we sent there.
                </>
              )}
            </div>
          </div>
          <div className="ac-actions">
            <button className="btn" onClick={() => setChangingEmail(true)}>
              <EnvelopeIcon /> change email
            </button>
          </div>
        </div>
        <div className="ac-row">
          <div>
            <div className="t">
              <UserCircleIcon /> account
            </div>
            <div className="d">
              signed in as <span className="text">{user.username}</span>
            </div>
          </div>
          <div className="ac-actions">
            <button className="btn" onClick={onEdit}>
              <PencilIcon /> edit profile
            </button>
            <button className="btn danger-text" onClick={doLogout}>
              <ArrowRightStartOnRectangleIcon /> log out
            </button>
          </div>
        </div>
      </div>
      {preview && <ImportPreview fileName={preview.fileName} parsed={preview.parsed} onClose={() => setPreview(null)} />}
      {changingEmail && (
        <ChangeEmailModal
          user={user}
          onClose={() => setChangingEmail(false)}
          onSent={(email) => {
            setChangingEmail(false);
            setPendingEmail(email);
            toast.success(`open the link we sent to ${email}. your email stays ${user.email} until then.`, { title: 'check your inbox' });
          }}
        />
      )}
    </Section>
  );
}
