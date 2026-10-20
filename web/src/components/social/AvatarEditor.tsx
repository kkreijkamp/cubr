import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { AlertCircle, ImagePlus, Trash2, Upload, ZoomIn, ZoomOut } from 'lucide-react';
import { friendlyError } from './util';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { toast } from '../../lib/toast';
import { Avatar } from '../Avatar';
import { Spinner } from '../Spinner';
import './social.css';
import './avatar-editor.css';

const ACCEPT = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const EXT_RE = /\.(png|jpe?g|webp|gif)$/i;
const MAX_FILE_BYTES = 15 * 1024 * 1024;
/** server limit for the encoded picture */
const MAX_UPLOAD_BYTES = 300 * 1024;
/** exported picture: OUT x OUT px */
const OUT = 256;
const MAX_ZOOM = 4;
const PREVIEWS = [64, 36, 20];

interface Source {
  url: string;
  img: HTMLImageElement;
  w: number;
  h: number;
}
/** zoom in [1, MAX_ZOOM] relative to "cover"; (cx, cy) = image pixel under the viewport centre */
interface View {
  zoom: number;
  cx: number;
  cy: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Keep the crop square inside the image (independent of the viewport's pixel size). */
function clampView(v: View, src: Source): View {
  const zoom = clamp(v.zoom, 1, MAX_ZOOM);
  const half = Math.min(src.w, src.h) / (2 * zoom);
  return { zoom, cx: clamp(v.cx, half, src.w - half), cy: clamp(v.cy, half, src.h - half) };
}

/** CSS for drawing `src` with `view` inside a square of `size` px. */
function imageStyle(src: Source, view: View, size: number): CSSProperties {
  const s = (size / Math.min(src.w, src.h)) * view.zoom;
  return {
    width: src.w * s,
    height: src.h * s,
    transform: `translate3d(${size / 2 - view.cx * s}px, ${size / 2 - view.cy * s}px, 0)`,
  };
}

function makeCanvas(size: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  return c;
}
const toBlob = (canvas: HTMLCanvasElement, type: string, quality: number) =>
  new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));

/** Render the crop to OUTxOUT and encode it: webp, or jpeg where webp encoding isn't supported (Safari). */
async function renderAvatar(img: CanvasImageSource, src: Pick<Source, 'w' | 'h'>, view: View): Promise<Blob> {
  let side = Math.min(src.w, src.h) / view.zoom;
  let sx = view.cx - side / 2;
  let sy = view.cy - side / 2;
  let from: CanvasImageSource = img;
  // halve big photos step by step - a single huge downscale aliases in some browsers
  while (side > OUT * 2) {
    const next = Math.ceil(side / 2);
    const step = makeCanvas(next);
    const sctx = step.getContext('2d')!;
    sctx.imageSmoothingQuality = 'high';
    sctx.drawImage(from, sx, sy, side, side, 0, 0, next, next);
    from = step;
    sx = 0;
    sy = 0;
    side = next;
  }
  const canvas = makeCanvas(OUT);
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(from, sx, sy, side, side, 0, 0, OUT, OUT);

  let blob = await toBlob(canvas, 'image/webp', 0.86);
  if (blob && blob.type === 'image/webp') {
    if (blob.size > MAX_UPLOAD_BYTES) blob = await toBlob(canvas, 'image/webp', 0.7);
  } else {
    // jpeg has no alpha: flatten transparent pixels onto white instead of black
    const flat = makeCanvas(OUT);
    const fctx = flat.getContext('2d')!;
    fctx.fillStyle = '#fff';
    fctx.fillRect(0, 0, OUT, OUT);
    fctx.drawImage(canvas, 0, 0);
    blob = await toBlob(flat, 'image/jpeg', 0.88);
    if (blob && blob.size > MAX_UPLOAD_BYTES) blob = await toBlob(flat, 'image/jpeg', 0.7);
  }
  if (!blob) throw new Error('your browser could not process that image - try another one');
  return blob;
}

function avatarError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 400) return 'the server could not read that image - try another file';
    if (err.status === 413) return 'that picture is too large to upload - try another image';
    if (err.status === 415) return 'that image format is not supported - try a png or jpg';
    if (err.status === 429) return 'you have changed your picture a lot recently - try again in a little while';
    if (err.status === 401) return 'your session expired - please log in again';
    if (err.status === 404 || err.status === 405) return 'profile pictures are not available on this server yet';
    if (err.status === 0) return 'could not reach the server - check your connection';
  }
  return friendlyError(err, 'the auth service');
}

const formatMb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} mb`;

interface Props {
  /** called after a successful upload (e.g. close the surrounding modal) */
  onDone?: () => void;
  /** "cancel" while cropping: defaults to going back to the picker */
  onCancel?: () => void;
}

/**
 * Pick (button / drag & drop) -> crop (drag, pinch, wheel, slider, keyboard) -> 256x256 webp ->
 * PUT /api/auth/me/avatar -> auth.setUser. Also removes the current picture. No dependencies.
 */
export function AvatarEditor({ onDone, onCancel }: Props) {
  const { user, setUser } = useAuth();
  const [source, setSource] = useState<Source | null>(null);
  const [view, setViewState] = useState<View>({ zoom: 1, cx: 0, cy: 0 });
  const [vp, setVp] = useState(240);
  const [busy, setBusy] = useState<'save' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const fileRef = useRef<HTMLInputElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef(view);
  const sourceRef = useRef(source);
  const vpRef = useRef(vp);
  const loadId = useRef(0);
  const dragDepth = useRef(0);
  sourceRef.current = source;
  vpRef.current = vp;

  const setView = useCallback((v: View) => {
    const src = sourceRef.current;
    if (!src) return;
    const next = clampView(v, src);
    viewRef.current = next;
    setViewState(next);
  }, []);

  /** zoom to `zoom`, keeping the image point under viewport position (px, py) fixed */
  const zoomAt = useCallback(
    (zoom: number, px?: number, py?: number) => {
      const src = sourceRef.current;
      if (!src) return;
      const size = vpRef.current;
      const v = viewRef.current;
      const x = (px ?? size / 2) - size / 2;
      const y = (py ?? size / 2) - size / 2;
      const base = size / Math.min(src.w, src.h);
      const z = clamp(zoom, 1, MAX_ZOOM);
      const ix = v.cx + x / (base * v.zoom);
      const iy = v.cy + y / (base * v.zoom);
      setView({ zoom: z, cx: ix - x / (base * z), cy: iy - y / (base * z) });
    },
    [setView],
  );

  // revoke the object URL of a replaced / abandoned image
  useEffect(() => {
    if (!source) return;
    return () => URL.revokeObjectURL(source.url);
  }, [source]);

  // track the rendered viewport size (it shrinks on narrow screens)
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const measure = () => el.clientWidth > 0 && setVp(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [source]);

  // wheel zoom needs a non-passive listener to stop the modal from scrolling
  useEffect(() => {
    const el = viewportRef.current;
    if (!el || !source) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (busy) return;
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      const rect = el.getBoundingClientRect();
      zoomAt(viewRef.current.zoom * Math.exp(-dy * 0.0015), e.clientX - rect.left, e.clientY - rect.top);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [source, busy, zoomAt]);

  useEffect(() => {
    if (!confirmRemove) return;
    const t = setTimeout(() => setConfirmRemove(false), 4000);
    return () => clearTimeout(t);
  }, [confirmRemove]);

  const openPicker = () => fileRef.current?.click();

  const loadFile = (file: File | null | undefined) => {
    if (!file) return;
    setError(null);
    const typeOk = ACCEPT.includes(file.type) || (!file.type && EXT_RE.test(file.name));
    if (!typeOk) {
      setError(`"${file.name}" is not a png, jpg, webp or gif image`);
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setError(`that image is ${formatMb(file.size)} - please pick one under 15 mb`);
      return;
    }
    const id = ++loadId.current;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      if (id !== loadId.current || !img.naturalWidth || !img.naturalHeight) {
        URL.revokeObjectURL(url);
        if (id === loadId.current) setError('could not read that image - the file may be damaged');
        return;
      }
      const src: Source = { url, img, w: img.naturalWidth, h: img.naturalHeight };
      sourceRef.current = src;
      setSource(src);
      setView({ zoom: 1, cx: src.w / 2, cy: src.h / 2 });
      requestAnimationFrame(() => viewportRef.current?.focus({ preventScroll: true }));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      if (id === loadId.current) setError('could not read that image - the file may be damaged');
    };
    img.src = url;
  };

  const onFileInput = (e: ChangeEvent<HTMLInputElement>) => {
    loadFile(e.target.files?.[0]);
    e.target.value = ''; // picking the same file again must fire change
  };

  // ---------------------------------------------------------------- drag & drop (files)
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes('Files');
  const onDragEnter = (e: DragEvent) => {
    if (!hasFiles(e) || busy) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  };
  const onDragOver = (e: DragEvent) => {
    if (!hasFiles(e) || busy) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };
  const onDragLeave = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };
  const onDrop = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (!busy) loadFile(e.dataTransfer.files[0]);
  };

  // ---------------------------------------------------------------- pan & pinch (pointer events)
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ view: View; x: number; y: number; dist: number } | null>(null);

  const centroid = () => {
    const pts = [...pointers.current.values()];
    const x = pts.reduce((a, p) => a + p.x, 0) / pts.length;
    const y = pts.reduce((a, p) => a + p.y, 0) / pts.length;
    const dist = pts.length >= 2 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0;
    return { x, y, dist };
  };
  const startGesture = () => {
    gesture.current = pointers.current.size ? { view: viewRef.current, ...centroid() } : null;
  };
  const localPoint = (e: ReactPointerEvent) => {
    const rect = viewportRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (busy || (e.pointerType === 'mouse' && e.button !== 0)) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic / already-released pointer: panning still works while inside the viewport */
    }
    pointers.current.set(e.pointerId, localPoint(e));
    startGesture();
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const src = sourceRef.current;
    const g = gesture.current;
    if (!src || !g || !pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, localPoint(e));
    const now = centroid();
    const size = vpRef.current;
    const base = size / Math.min(src.w, src.h);
    const zoom = clamp(g.dist > 0 && now.dist > 0 ? g.view.zoom * (now.dist / g.dist) : g.view.zoom, 1, MAX_ZOOM);
    // the image point that was under the gesture centre stays under it (pan + pinch in one)
    const ix = g.view.cx + (g.x - size / 2) / (base * g.view.zoom);
    const iy = g.view.cy + (g.y - size / 2) / (base * g.view.zoom);
    setView({ zoom, cx: ix - (now.x - size / 2) / (base * zoom), cy: iy - (now.y - size / 2) / (base * zoom) });
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.delete(e.pointerId)) return;
    startGesture();
  };

  // ---------------------------------------------------------------- save / remove
  const reset = () => {
    loadId.current++;
    pointers.current.clear();
    gesture.current = null;
    sourceRef.current = null;
    setSource(null);
  };

  const save = async () => {
    const src = sourceRef.current;
    if (!src || busy) return;
    setBusy('save');
    setError(null);
    try {
      const blob = await renderAvatar(src.img, src, viewRef.current);
      const res = await api.auth.uploadAvatar(blob);
      setUser(res.user);
      toast.success('profile picture updated');
      setBusy(null);
      reset();
      onDone?.();
    } catch (err) {
      setError(avatarError(err));
      setBusy(null);
    }
  };

  const remove = async () => {
    if (busy) return;
    if (!confirmRemove) {
      setConfirmRemove(true);
      return;
    }
    setConfirmRemove(false);
    setBusy('remove');
    setError(null);
    try {
      const res = await api.auth.removeAvatar();
      setUser(res.user);
      toast.success('profile picture removed');
    } catch (err) {
      setError(avatarError(err));
    }
    setBusy(null);
  };

  const onViewportKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const src = sourceRef.current;
    if (!src || busy || e.altKey || e.ctrlKey || e.metaKey) return;
    const v = viewRef.current;
    // arrow keys move the image (like dragging it) by 10 px, 40 px with shift
    const step = (e.shiftKey ? 40 : 10) / ((vpRef.current / Math.min(src.w, src.h)) * v.zoom);
    switch (e.key) {
      case 'ArrowLeft':
        setView({ ...v, cx: v.cx + step });
        break;
      case 'ArrowRight':
        setView({ ...v, cx: v.cx - step });
        break;
      case 'ArrowUp':
        setView({ ...v, cy: v.cy + step });
        break;
      case 'ArrowDown':
        setView({ ...v, cy: v.cy - step });
        break;
      case '+':
      case '=':
        zoomAt(v.zoom * 1.1);
        break;
      case '-':
      case '_':
        zoomAt(v.zoom / 1.1);
        break;
      case '0':
        setView({ zoom: 1, cx: src.w / 2, cy: src.h / 2 });
        break;
      case 'Enter':
        void save();
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  if (!user) return null;
  const hasAvatar = Boolean(user.avatarUrl);

  return (
    <div
      className={`ae${dragging ? ' dragging' : ''}${busy ? ' busy' : ''}`}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <input ref={fileRef} type="file" accept={ACCEPT.join(',')} hidden onChange={onFileInput} tabIndex={-1} />

      {!source ? (
        <div className="ae-drop">
          <div className="ae-current">
            <Avatar user={user} size={72} />
            {dragging && (
              <span className="ae-current-drop" aria-hidden="true">
                <ImagePlus />
              </span>
            )}
          </div>
          <div className="ae-drop-body">
            <div className="ae-drop-line">
              <button type="button" className="btn small" onClick={openPicker} disabled={busy !== null}>
                <Upload /> {hasAvatar ? 'change picture' : 'upload picture'}
              </button>
              <span className="ae-drop-or">{dragging ? 'drop it!' : 'or drop an image here'}</span>
            </div>
            <span className="ae-hint">png, jpg, webp or gif - up&nbsp;to&nbsp;15&nbsp;mb</span>
            {hasAvatar && (
              <button
                type="button"
                className={`btn-text small ae-remove${confirmRemove ? ' confirm' : ''}`}
                onClick={remove}
                disabled={busy !== null}
              >
                {busy === 'remove' ? <Spinner size={14} /> : <Trash2 />}
                {confirmRemove ? 'click again to remove' : 'remove picture'}
              </button>
            )}
          </div>
        </div>
      ) : (
        <>
          <div className="ae-crop">
            <div
              ref={viewportRef}
              className="ae-viewport"
              tabIndex={0}
              role="group"
              aria-roledescription="image cropper"
              aria-label="crop area: drag or use the arrow keys to move the picture, plus and minus to zoom, enter to save"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onKeyDown={onViewportKey}
            >
              <img src={source.url} alt="" draggable={false} style={imageStyle(source, view, vp)} />
              <div className="ae-mask" aria-hidden="true" />
            </div>

            <div className="ae-side">
              <div className="ae-previews" aria-hidden="true">
                {PREVIEWS.map((size) => (
                  <span key={size} className="ae-preview" style={{ width: size, height: size }}>
                    <img src={source.url} alt="" draggable={false} style={imageStyle(source, view, size)} />
                  </span>
                ))}
              </div>
              <div className="ae-zoom">
                <button
                  type="button"
                  className="btn-text"
                  onClick={() => zoomAt(view.zoom / 1.25)}
                  disabled={busy !== null || view.zoom <= 1}
                  aria-label="zoom out"
                >
                  <ZoomOut />
                </button>
                <input
                  type="range"
                  min={1}
                  max={MAX_ZOOM}
                  step={0.01}
                  value={view.zoom}
                  onChange={(e) => zoomAt(Number(e.target.value))}
                  disabled={busy !== null}
                  aria-label="zoom"
                  aria-valuetext={`${Math.round(view.zoom * 100)}%`}
                />
                <button
                  type="button"
                  className="btn-text"
                  onClick={() => zoomAt(view.zoom * 1.25)}
                  disabled={busy !== null || view.zoom >= MAX_ZOOM}
                  aria-label="zoom in"
                >
                  <ZoomIn />
                </button>
              </div>
              <div className="ae-hint ae-hint-pointer">drag to move - scroll to zoom</div>
              <div className="ae-hint ae-hint-touch">drag to move - pinch to zoom</div>
              <div className="ae-hint ae-keys">
                <kbd>arrow keys</kbd>
                <span>move</span>
                <kbd>+</kbd>
                <kbd>-</kbd>
                <span>zoom</span>
                <kbd>0</kbd>
                <span>reset</span>
              </div>
            </div>
          </div>

          <div className="ae-actions">
            <button type="button" className="btn-text small" onClick={openPicker} disabled={busy !== null}>
              <ImagePlus /> choose another
            </button>
            <span className="ae-spacer" />
            <button
              type="button"
              className="btn"
              onClick={() => {
                setError(null);
                if (onCancel) onCancel();
                else reset();
              }}
              disabled={busy !== null}
            >
              cancel
            </button>
            <button type="button" className={`btn primary${busy === 'save' ? ' ae-saving' : ''}`} onClick={save} disabled={busy !== null} aria-busy={busy === 'save'}>
              {busy === 'save' && <Spinner size={16} />} {busy === 'save' ? 'saving...' : 'save picture'}
            </button>
          </div>
        </>
      )}

      {error && (
        <div className="ep-error" role="alert">
          <AlertCircle size={15} /> {error}
        </div>
      )}
    </div>
  );
}
