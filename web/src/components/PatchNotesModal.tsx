import { Modal } from './Modal';
import { PATCH_NOTES, releaseFor } from '../content/patchNotes';

const fmtDate = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }).toLowerCase();

/** Release notes, newest first (opened from the version in the footer). The release the running
 *  version belongs to is marked "current"; in development (version "dev") none is. */
export function PatchNotesModal({ running, onClose }: { running: string | null; onClose: () => void }) {
  const current = releaseFor(running);
  return (
    <Modal title="patch notes" onClose={onClose}>
      <div className="patch-notes">
        {PATCH_NOTES.map((note) => (
          <section key={note.version} className="patch-note" aria-labelledby={`pn-${note.version}`}>
            <h3 id={`pn-${note.version}`} className="patch-note-head">
              <span className="patch-note-version">v{note.version}</span>
              <span className="patch-note-date">{fmtDate(note.date)}</span>
              {current === note.version && <span className="patch-note-current">current</span>}
            </h3>
            <p className="patch-note-title">{note.title}</p>
            {note.sections.map((section) => (
              <div key={section.heading} className="patch-note-section">
                <div className="patch-note-heading">{section.heading}</div>
                <ul>
                  {section.items.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            ))}
          </section>
        ))}
      </div>
    </Modal>
  );
}
