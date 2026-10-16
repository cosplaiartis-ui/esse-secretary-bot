import { describe, it, expect } from "vitest";
import { parseAmount, rupiah } from "../src/money.js";
import { Secretary } from "../src/service.js";
import { MemoryStore } from "../src/store.js";
import { toUtc } from "../src/time.js";
import { SecretaryBrain } from "../src/brain.js";

const TZ = "Asia/Makassar";
describe("parseAmount", () => {
  it.each([
    ["50000", 50000], ["50.000", 50000], ["50rb", 50000], ["50 rb", 50000], ["50k", 50000], ["50ribu", 50000],
    ["1,5jt", 1500000], ["1.5jt", 1500000], ["1,5 juta", 1500000], ["2jt", 2000000], ["Rp 75.000", 75000],
    ["Rp75.000", 75000], ["1.250.000", 1250000], ["12,5rb", 12500],
  ])("%s", (s, v) => expect(parseAmount(s + " VIP")).toEqual({ amount: v, rest: "VIP" }));
  it("rejects junk", () => {
    expect(parseAmount("abc")).toBeNull();
    expect(parseAmount("0")).toBeNull();
    expect(parseAmount("5,5")).toBeNull();
  });
  it("formats rupiah", () => {
    expect(rupiah(50000)).toBe("Rp50.000");
    expect(rupiah(1500000)).toBe("Rp1.500.000");
    expect(rupiah(500)).toBe("Rp500");
  });
});

function setup(owner = 1) {
  let now = toUtc({ y: 2026, mo: 10, d: 16, h: 13, mi: 0 }, TZ);
  const sec = new Secretary(new MemoryStore(), () => now, owner);
  return { sec, set: (d: number, h: number, mi = 0) => (now = toUtc({ y: 2026, mo: 10, d, h, mi }, TZ)) };
}

describe("income", () => {
  it("records, totals, breaks down and undoes", async () => {
    const { sec } = setup();
    expect(await sec.handle(1, 1, "/masuk 50rb VIP")).toContain("Rp50.000");
    await sec.handle(1, 1, "/masuk 50.000 vip");
    const r = await sec.handle(1, 1, "/masuk 1,5jt endorse");
    expect(r).toContain("Total masuk hari ini: Rp1.600.000");
    const rep = await sec.handle(1, 1, "/pendapatan");
    expect(rep).toContain("Jumlah transaksi masuk: 3");
    expect(rep).toContain("• endorse: Rp1.500.000 (1x)");
    expect(rep).toContain("• vip: Rp100.000 (2x)");
    expect(await sec.handle(1, 1, "/hapusmasuk 3")).toContain("dihapus");
    expect(await sec.handle(1, 1, "/pendapatan")).toContain("Total masuk: Rp100.000");
    await sec.handle(1, 1, "/keluar 20rb kuota");
    expect(await sec.handle(1, 1, "/pendapatan")).toContain("Bersih: Rp80.000");
  });

  it("is owner-only", async () => {
    const { sec } = setup(1);
    expect(await sec.handle(2, 2, "/masuk 50rb")).toContain("khusus pemilik");
    expect(await sec.handle(2, 2, "/pendapatan")).toContain("khusus pemilik");
  });

  it("midnight report of previous day, once, with catch-up", async () => {
    const { sec, set } = setup();
    await sec.handle(1, 1, "/ringkasan off");
    await sec.handle(1, 1, "/masuk 50rb VIP");
    await sec.handle(1, 1, "/masuk 100rb VIP");
    expect(await sec.tick()).toHaveLength(0);         // same day: nothing yet
    set(16, 23, 55);
    expect(await sec.tick()).toHaveLength(0);
    set(17, 0, 0);
    const m = await sec.tick();
    expect(m).toHaveLength(1);
    expect(m[0].text).toContain("Laporan pendapatan kemarin (2026-10-16)");
    expect(m[0].text).toContain("Total masuk: Rp150.000");
    expect(m[0].text).toContain("Jumlah transaksi masuk: 2");
    set(17, 0, 5);
    expect(await sec.tick()).toHaveLength(0);         // once per day
    // late tick next day (cron missed midnight) still sends, with an empty day report
    set(18, 7, 30);
    const late = await sec.tick();
    expect(late).toHaveLength(1);
    expect(late[0].text).toContain("(2026-10-17)");
    expect(late[0].text).toContain("Total masuk: Rp0");
  });

  it("natural phrasing via LLM tool call", async () => {
    const { sec } = setup();
    let n = 0;
    const llm = { async complete() {
      return n++ === 0
        ? { content: null, tool_calls: [{ id: "a", type: "function" as const, function: { name: "add_income", arguments: '{"amount":"50rb","note":"VIP"}' } }] }
        : { content: "Dicatat ya, 50rb dari VIP." };
    } };
    await new SecretaryBrain(sec, llm).handle(1, 1, "dapet 50rb dari VIP");
    expect(await sec.handle(1, 1, "/pendapatan")).toContain("• vip: Rp50.000 (1x)");
  });
});
