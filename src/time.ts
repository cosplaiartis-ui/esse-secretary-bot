// Timezone helpers built on Intl only (no external date library).

export interface Wall {
  y: number; mo: number; d: number; h: number; mi: number; // mo is 1-12
}

export function wallOf(utcMs: number, tz: string): Wall & { dow: number } {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "numeric", weekday: "short",
  });
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(new Date(utcMs))) p[x.type] = x.value;
  const dows = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, dow: dows.indexOf(p.weekday) };
}

/** Convert a wall-clock time in tz to a UTC epoch ms. */
export function toUtc(w: Wall, tz: string): number {
  const guess = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi);
  let ts = guess;
  for (let i = 0; i < 2; i++) {
    const got = wallOf(ts, tz);
    const gotMs = Date.UTC(got.y, got.mo - 1, got.d, got.h, got.mi);
    ts += guess - gotMs;
  }
  return ts;
}

/** Add days to a calendar date (wall), normalising month/year. */
export function addDays(w: Wall, n: number): Wall {
  const t = new Date(Date.UTC(w.y, w.mo - 1, w.d + n));
  return { ...w, y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

export function dowOf(w: Wall): number {
  return new Date(Date.UTC(w.y, w.mo - 1, w.d)).getUTCDay();
}

export function isValidTz(tz: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

const HARI = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];
const BULAN = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
const pad = (n: number) => String(n).padStart(2, "0");

export function fmt(utcMs: number, tz: string): string {
  const w = wallOf(utcMs, tz);
  return `${HARI[w.dow]}, ${w.d} ${BULAN[w.mo - 1]} ${w.y} ${pad(w.h)}:${pad(w.mi)}`;
}
export function fmtTime(utcMs: number, tz: string): string {
  const w = wallOf(utcMs, tz);
  return `${pad(w.h)}:${pad(w.mi)}`;
}
export function dayKey(utcMs: number, tz: string): string {
  const w = wallOf(utcMs, tz);
  return `${w.y}-${pad(w.mo)}-${pad(w.d)}`;
}
export { HARI };
