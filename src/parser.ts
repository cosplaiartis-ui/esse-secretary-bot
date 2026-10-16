// Rule-based Indonesian/English natural-ish date/time parser.
import { Wall, wallOf, toUtc, addDays, dowOf } from "./time.js";

export type Recurrence =
  | { kind: "daily" }
  | { kind: "weekly"; dow: number }
  | { kind: "weekdays" }
  | { kind: "monthly"; day: number };

export interface Parsed {
  at: number;            // UTC ms of first occurrence
  text: string;          // remaining text (what the reminder/event is about)
  recur?: Recurrence;
  hasTime: boolean;
}

const DOW: Record<string, number> = {
  minggu: 0, ahad: 0, sunday: 0, sun: 0,
  senin: 1, monday: 1, mon: 1,
  selasa: 2, tuesday: 2, tue: 2,
  rabu: 3, wednesday: 3, wed: 3,
  kamis: 4, thursday: 4, thu: 4,
  jumat: 5, "jum'at": 5, friday: 5, fri: 5,
  sabtu: 6, saturday: 6, sat: 6,
};
const MONTHS: Record<string, number> = {
  jan: 1, januari: 1, january: 1, feb: 2, februari: 2, february: 2, mar: 3, maret: 3, march: 3,
  apr: 4, april: 4, mei: 5, may: 5, jun: 6, juni: 6, june: 6, jul: 7, juli: 7, july: 7,
  agu: 8, agt: 8, agustus: 8, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  okt: 10, oktober: 10, oct: 10, october: 10, nov: 11, november: 11, des: 12, desember: 12, dec: 12, december: 12,
};
const DOW_RE = Object.keys(DOW).sort((a, b) => b.length - a.length).join("|");
const MON_RE = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");

const LEAD = /^(ingatkan( saya| aku)?|ingetin( aku| saya)?|remind me( to)?|remind|reminder|pengingat|jadwal(kan)?|schedule|event|acara)\b\s*/i;
const FILLER = /^(untuk|utk|buat|to|about|tentang|soal|:|-)\s+/i;

export function parseWhen(input: string, nowMs: number, tz: string): Parsed | null {
  let s = " " + input.trim().replace(LEAD, "") + " ";
  const now = wallOf(nowMs, tz);
  let date: Wall | null = null;
  let hour: number | null = null, minute = 0;
  let recur: Recurrence | undefined;
  let relMs: number | null = null;

  const take = (re: RegExp): RegExpMatchArray | null => {
    const m = s.match(re);
    if (m) s = s.replace(m[0], " ");
    return m;
  };

  // Relative: "30 menit lagi", "dalam 2 jam", "in 10 minutes"
  let m = take(/\s(?:dalam|in)\s+(\d+)\s*(menit|mnt|min|minutes?|mins?|jam|hours?|hrs?|hari|days?)\s(?:lagi\s)?/i)
    || take(/\s(\d+)\s*(menit|mnt|min|minutes?|mins?|jam|hours?|hrs?|hari|days?)\s+(?:lagi|from now)\s/i);
  if (m) {
    const n = +m[1], u = m[2].toLowerCase();
    const mult = /^(menit|mnt|min)/.test(u) ? 60e3 : /^(jam|hour|hr)/.test(u) ? 3600e3 : 86400e3;
    relMs = nowMs + n * mult;
  }

  // Recurrence
  if (take(/\s(?:setiap|tiap)\s+hari\s+kerja\s|\s(?:every\s+)?weekdays?\s/i)) recur = { kind: "weekdays" };
  else if ((m = take(new RegExp(`\\s(?:setiap|tiap|every)\\s+(?:hari\\s+)?(${DOW_RE})\\s`, "i")))) recur = { kind: "weekly", dow: DOW[m[1].toLowerCase()] };
  else if (take(/\s(?:setiap|tiap)\s+hari\s|\severy\s*day\s|\sdaily\s|\stiap\s+pagi\s/i)) recur = { kind: "daily" };
  else if ((m = take(/\s(?:setiap|tiap)\s+tanggal\s+(\d{1,2})\s|\severy\s+month\s+on\s+(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\s/i))) recur = { kind: "monthly", day: +(m[1] ?? m[2]) };

  // Time: "jam 9", "jam 14:30", "pukul 7.15", "at 9am", "9:30 pm", "09.00"
  m = take(/\s(?:jam|pukul|pkl\.?|at|@)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|pagi|siang|sore|malam)?\s/i)
    || take(/\s(\d{1,2})[:.](\d{2})\s*(am|pm|pagi|siang|sore|malam)?\s/i)
    || take(/\s(\d{1,2})()\s*(am|pm)\s/i);
  if (m) {
    hour = +m[1]; minute = m[2] ? +m[2] : 0;
    const mer = (m[3] || "").toLowerCase();
    if ((mer === "pm" || mer === "sore" || mer === "malam") && hour < 12) hour += 12;
    if (mer === "siang" && hour < 11) hour += 12;
    if ((mer === "am" || mer === "pagi") && hour === 12) hour = 0;
    if (mer === "malam" && hour === 24) hour = 0;
    if (hour > 23 || minute > 59) return null;
  }

  // Date
  if (take(/\s(?:hari ini|today|nanti)\s/i)) date = now;
  else if (take(/\s(?:besok lusa|lusa|day after tomorrow)\s/i)) date = addDays(now, 2);
  else if (take(/\s(?:besok|tomorrow|bsk)\s/i)) date = addDays(now, 1);
  else if ((m = take(/\s(\d{4})-(\d{1,2})-(\d{1,2})\s/))) date = { ...now, y: +m[1], mo: +m[2], d: +m[3] };
  else if ((m = take(/\s(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\s/))) {
    const y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : now.y;
    date = { ...now, y, mo: +m[2], d: +m[1] };
    if (!m[3] && toUtc({ ...date, h: 23, mi: 59 }, tz) < nowMs) date.y++;
  } else if ((m = take(new RegExp(`\\s(?:tanggal|tgl|on)?\\s*(\\d{1,2})\\s+(${MON_RE})(?:\\s+(\\d{4}))?\\s`, "i")))
    || (m = take(new RegExp(`\\s(?:on\\s+)?(${MON_RE})\\s+(\\d{1,2})(?:,?\\s+(\\d{4}))?\\s`, "i")))) {
    const numFirst = /^\d/.test(m[1]);
    const d = +(numFirst ? m[1] : m[2]);
    const mo = MONTHS[(numFirst ? m[2] : m[1]).toLowerCase()];
    date = { ...now, y: m[3] ? +m[3] : now.y, mo, d };
    if (!m[3] && toUtc({ ...date, h: 23, mi: 59 }, tz) < nowMs) date.y++;
  } else if ((m = take(/\s(?:tanggal|tgl)\s+(\d{1,2})\s/i))) {
    date = { ...now, d: +m[1] };
    if (date.d < now.d) { date = { ...addDays({ ...now, d: 1 }, 32), d: +m[1] }; }
  } else if ((m = take(new RegExp(`\\s(?:hari\\s+|next\\s+|on\\s+)?(${DOW_RE})(?:\\s+(?:depan|ini))?\\s`, "i")))) {
    const target = DOW[m[1].toLowerCase()];
    let diff = (target - now.dow + 7) % 7;
    if (diff === 0) diff = 7;
    date = addDays(now, diff);
  }

  if (relMs === null && date === null && hour === null && !recur) return null;

  let at: number;
  const hasTime = hour !== null || relMs !== null;
  if (relMs !== null) {
    at = relMs;
  } else {
    const h = hour ?? 9; // default 09:00 when only a date is given
    if (recur) {
      at = firstRecurrence(recur, { ...now, h, mi: minute }, nowMs, tz);
    } else {
      const base = date ?? now;
      at = toUtc({ ...base, h, mi: minute }, tz);
      if (!date && at <= nowMs) at = toUtc({ ...addDays(now, 1), h, mi: minute }, tz); // "jam 9" already passed today
    }
  }

  let text = s.replace(/\s+/g, " ").trim();
  for (let i = 0; i < 3; i++) text = text.replace(FILLER, "").trim();
  return { at, text, recur, hasTime };
}

/** First occurrence of a recurrence strictly after nowMs, at wall time h:mi of `w`. */
export function firstRecurrence(r: Recurrence, w: Wall, nowMs: number, tz: string): number {
  for (let i = 0; i < 400; i++) {
    const day = addDays(w, i);
    if (!matches(r, day)) continue;
    const t = toUtc(day, tz);
    if (t > nowMs) return t;
  }
  throw new Error("no occurrence");
}

function matches(r: Recurrence, day: Wall): boolean {
  const dow = dowOf(day);
  switch (r.kind) {
    case "daily": return true;
    case "weekly": return dow === r.dow;
    case "weekdays": return dow >= 1 && dow <= 5;
    case "monthly": {
      const last = new Date(Date.UTC(day.y, day.mo, 0)).getUTCDate();
      return day.d === Math.min(r.day, last);
    }
  }
}

/** Next occurrence after a fired one, keeping the same wall-clock time in tz. */
export function nextOccurrence(r: Recurrence, prevAt: number, tz: string): number {
  return firstRecurrence(r, wallOf(prevAt, tz), prevAt + 60e3, tz);
}

export function describeRecur(r?: Recurrence): string {
  if (!r) return "";
  const H = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];
  switch (r.kind) {
    case "daily": return "setiap hari";
    case "weekdays": return "setiap hari kerja";
    case "weekly": return `setiap ${H[r.dow]}`;
    case "monthly": return `setiap tanggal ${r.day}`;
  }
}
