import { describe, it, expect } from "vitest";
import { parseWhen, nextOccurrence } from "../src/parser.js";
import { toUtc, fmt } from "../src/time.js";

const TZ = "Asia/Makassar";
// Friday 16 Oct 2026 13:12 WITA
const NOW = toUtc({ y: 2026, mo: 10, d: 16, h: 13, mi: 12 }, TZ);
const p = (s: string, tz = TZ) => parseWhen(s, NOW, tz)!;
const f = (s: string) => fmt(p(s).at, TZ);

describe("parseWhen", () => {
  it("besok jam 9 rapat", () => {
    expect(f("ingatkan besok jam 9 rapat")).toBe("Sabtu, 17 Okt 2026 09:00");
    expect(p("ingatkan besok jam 9 rapat").text).toBe("rapat");
  });
  it("English tomorrow at 9am", () => {
    const r = p("remind me tomorrow at 9am to call mom");
    expect(fmt(r.at, TZ)).toBe("Sabtu, 17 Okt 2026 09:00");
    expect(r.text).toBe("call mom");
  });
  it("relative minutes", () => {
    const r = p("30 menit lagi angkat jemuran");
    expect(r.at - NOW).toBe(30 * 60e3);
    expect(r.text).toBe("angkat jemuran");
    expect(p("in 2 hours stretch").at - NOW).toBe(2 * 3600e3);
  });
  it("meridiem words", () => {
    expect(f("jam 7 malam makan")).toBe("Jumat, 16 Okt 2026 19:00");
    expect(f("besok jam 3 sore gym")).toBe("Sabtu, 17 Okt 2026 15:00");
    expect(f("lusa pukul 14.30 dokter")).toBe("Minggu, 18 Okt 2026 14:30");
  });
  it("time already passed today rolls to tomorrow", () => {
    expect(f("jam 9 sarapan")).toBe("Sabtu, 17 Okt 2026 09:00");
  });
  it("weekday names", () => {
    expect(f("senin jam 8 laporan")).toBe("Senin, 19 Okt 2026 08:00");
    expect(f("jumat depan jam 10 x")).toBe("Jumat, 23 Okt 2026 10:00");
  });
  it("explicit dates", () => {
    expect(f("20/10 14:00 meeting")).toBe("Selasa, 20 Okt 2026 14:00");
    expect(f("tanggal 5 november jam 10 ultah")).toBe("Kamis, 5 Nov 2026 10:00");
    expect(f("2027-01-02 jam 8 x")).toBe("Sabtu, 2 Jan 2027 08:00");
    expect(f("1/3 jam 8 x")).toBe("Senin, 1 Mar 2027 08:00"); // past date this year rolls forward
  });
  it("date without time defaults to 09:00", () => {
    expect(p("besok bayar listrik").hasTime).toBe(false);
    expect(f("besok bayar listrik")).toBe("Sabtu, 17 Okt 2026 09:00");
  });
  it("recurring", () => {
    const d = p("ingatkan setiap hari jam 7 minum obat");
    expect(d.recur).toEqual({ kind: "daily" });
    expect(fmt(d.at, TZ)).toBe("Sabtu, 17 Okt 2026 07:00");
    expect(d.text).toBe("minum obat");
    const w = p("tiap senin jam 8 laporan mingguan");
    expect(w.recur).toEqual({ kind: "weekly", dow: 1 });
    expect(fmt(w.at, TZ)).toBe("Senin, 19 Okt 2026 08:00");
    const m = p("setiap tanggal 31 jam 9 bayar sewa");
    expect(m.recur).toEqual({ kind: "monthly", day: 31 });
    expect(fmt(m.at, TZ)).toBe("Sabtu, 31 Okt 2026 09:00");
    expect(fmt(nextOccurrence(m.recur!, m.at, TZ), TZ)).toBe("Senin, 30 Nov 2026 09:00");
    const wd = p("every weekday at 8:30 standup");
    expect(fmt(wd.at, TZ)).toBe("Senin, 19 Okt 2026 08:30");
    expect(fmt(nextOccurrence(wd.recur!, wd.at, TZ), TZ)).toBe("Selasa, 20 Okt 2026 08:30");
  });
  it("respects timezone", () => {
    const a = parseWhen("besok jam 9 x", NOW, "Asia/Jakarta")!;
    expect(a.at - p("besok jam 9 x").at).toBe(3600e3);
  });
  it("returns null without any time info", () => {
    expect(parseWhen("ingatkan rapat", NOW, TZ)).toBeNull();
    expect(parseWhen("jam 25 x", NOW, TZ)).toBeNull();
  });
});
