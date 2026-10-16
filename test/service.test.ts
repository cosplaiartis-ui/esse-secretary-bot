import { describe, it, expect } from "vitest";
import { Secretary } from "../src/service.js";
import { MemoryStore } from "../src/store.js";
import { toUtc } from "../src/time.js";

const TZ = "Asia/Makassar";
function setup(start = toUtc({ y: 2026, mo: 10, d: 16, h: 13, mi: 12 }, TZ)) {
  let now = start;
  const sec = new Secretary(new MemoryStore(), () => now);
  return { sec, at: (h: number, mi = 0, d = 16) => (now = toUtc({ y: 2026, mo: 10, d, h, mi }, TZ)), adv: (ms: number) => (now += ms) };
}

describe("Secretary", () => {
  it("one-off reminder fires once", async () => {
    const { sec, adv } = setup();
    expect(await sec.handle(1, 1, "/ingat 10 menit lagi telepon ibu")).toContain("telepon ibu");
    await sec.tick(); // summary may fire; ignore
    adv(5 * 60e3);
    expect((await sec.tick()).filter(m => m.text.includes("telepon"))).toHaveLength(0);
    adv(6 * 60e3);
    expect((await sec.tick()).map(m => m.text)).toEqual(["⏰ Pengingat: telepon ibu"]);
    expect(await sec.tick()).toHaveLength(0);
    expect(await sec.handle(1, 1, "/pengingat")).toBe("Belum ada pengingat.");
  });

  it("free text reminder and recurring reschedule", async () => {
    const { sec, at } = setup();
    await sec.handle(1, 1, "ingatkan tiap hari jam 14 minum air");
    await sec.tick();
    at(14, 2);
    expect((await sec.tick()).some(m => m.text.includes("minum air"))).toBe(true);
    expect(await sec.handle(1, 1, "/pengingat")).toContain("Sabtu, 17 Okt 2026 14:00");
  });

  it("morning summary once per day after summary hour", async () => {
    const { sec, at } = setup();
    await sec.handle(1, 1, "/tugas kirim invoice");
    await sec.handle(1, 1, "/jadwal besok jam 10 meeting klien");
    await sec.tick(); // sends today's summary (13:12 > 7)
    at(6, 55, 17);
    expect(await sec.tick()).toHaveLength(0);
    at(7, 0, 17);
    const msgs = await sec.tick();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toContain("meeting klien");
    expect(msgs[0].text).toContain("kirim invoice");
    at(7, 5, 17);
    expect(await sec.tick()).toHaveLength(0);
  });

  it("notes, tasks, agenda, timezone", async () => {
    const { sec } = setup();
    await sec.handle(1, 1, "/catat wifi kantor: rahasia123");
    await sec.handle(1, 1, "/catat beli kopi");
    expect(await sec.handle(1, 1, "/cari WIFI")).toContain("wifi kantor");
    expect(await sec.handle(1, 1, "/cari teh")).toContain("tidak ada");
    const t = await sec.handle(1, 1, "/tugas review PR");
    const id = t.match(/#(\d+)/)![1];
    await sec.handle(1, 1, `/selesai ${id}`);
    expect(await sec.handle(1, 1, "/tugasku")).toContain("✅");
    await sec.handle(1, 1, "/jadwal jam 16 ngopi");
    expect(await sec.handle(1, 1, "/hariini")).toContain("16:00  ngopi");
    expect(await sec.handle(1, 1, "/mingguini")).toContain("ngopi");
    expect(await sec.handle(1, 1, "/zona Mars/Base")).toContain("tidak dikenal");
    expect(await sec.handle(1, 1, "/zona Asia/Jakarta")).toContain("Asia/Jakarta");
    expect(await sec.handle(1, 1, "/hariini")).toContain("15:00  ngopi");
  });

  it("rejects unclear reminders", async () => {
    const { sec } = setup();
    expect(await sec.handle(1, 1, "/ingat rapat")).toContain("belum jelas");
  });
});

import { OWNER_COMMANDS } from "../src/commands.js";
describe("command menu", () => {
  it("valid for Telegram and documented in /help", async () => {
    const sec = new Secretary(new MemoryStore());
    const help = await sec.handle(1, 1, "/help");
    expect(await sec.handle(1, 1, "/start")).toBe(help);
    expect(OWNER_COMMANDS.length).toBeLessThanOrEqual(100);
    for (const c of OWNER_COMMANDS) {
      expect(c.command).toMatch(/^[a-z0-9_]{1,32}$/);
      expect(c.description.length).toBeLessThanOrEqual(256);
      expect(help).toContain(`/${c.command}`);
    }
  });
});
