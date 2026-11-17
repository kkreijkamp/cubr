import { flagEmoji } from '../lib/format';
import './Flag.css';

// Country flags from one sprite, assets/country-flags.png (from SlavkoPekaric/Country-Flags-Responsive-
// CSS-Sprite): flat 44 x 30 px flags in one column, a placeholder in slot 0, then CODES in order.
// They look the same everywhere, where emoji flags were two letters on Windows. The codes are ISO
// 3166-1 alpha-2, but "uk" for GB, plus a few retired ones (an, tp, zr). A country the sprite has no
// flag for (12 of the 250 in the country list: Kosovo, Palestine, Curaçao, ...) keeps its emoji flag.
const CODES = (
  'ad ae af ag ai al am an ao aq ar as at au aw az ba bb bd be bf bg bh bi bj bm bn bo br bs bt bv bw by bz ca cc cd cf cg ' +
  'ch ci ck cl cm cn co cr cu cv cx cy cz de dj dk dm do dz ec ee eg eh er es et fi fj fk fm fo fr ga gd ge gf gh gi gl gm ' +
  'gn gp gq gr gs gt gu gw gy hk hm hn hr ht hu id ie il in io iq ir is it jm jo jp ke kg kh ki km kn kp kr kw ky kz la lb ' +
  'lc li lk lr ls lt lu lv ly ma mc md me mg mh mk ml mm mn mo mp mq mr ms mt mu mv mw mx my mz na nc ne nf ng ni nl no np ' +
  'nr nu nz om pa pe pf pg ph pk pl pm pn pr pt pw py qa re ro rs ru rw sa sb sc sd se sg sh si sj sk sl sm sn so sr ss st ' +
  'sv sy sz tc td tf tg th tj tk tl tm tn to tp tr tt tv tw ty tz ua ug uk um us uy uz va vc ve vg vi vn vu wf ws ye za zm ' +
  'zr zw'
).split(' ');
const SLOTS = new Map(CODES.map((c, i) => [c, i + 1]));
/** the sprite's slots, the placeholder's included */
export const FLAG_SLOTS = CODES.length + 1;

/** A country code's slot in the sprite, or undefined when it has no flag there. */
export function flagSlot(code: string | null | undefined): number | undefined {
  if (!code || !/^[A-Za-z]{2}$/.test(code)) return undefined;
  const c = code.toLowerCase();
  return SLOTS.get(c === 'gb' ? 'uk' : c);
}

interface Props {
  code: string | null | undefined;
  /** the country's name: read out, and shown on hover (the code if there's none) */
  label?: string;
  /** the app's tooltip (data-tip) rather than the browser's (title) */
  tip?: boolean;
}

/** A country's flag, sized to the text around it (Flag.css). */
export function Flag({ code, label, tip }: Props) {
  if (!code) return null;
  const name = label || code.toUpperCase();
  const hover = tip ? { 'data-tip': name } : { title: name };
  const slot = flagSlot(code);
  if (slot === undefined) {
    const emoji = flagEmoji(code);
    return emoji ? (
      <span className="flag flag-emoji" role="img" aria-label={name} {...hover}>
        {emoji}
      </span>
    ) : null;
  }
  // the box has a flag's shape and the sprite its width, so slot n sits n box-heights down
  return <span className="flag" role="img" aria-label={name} {...hover} style={{ backgroundPositionY: `${(slot / (FLAG_SLOTS - 1)) * 100}%` }} />;
}
