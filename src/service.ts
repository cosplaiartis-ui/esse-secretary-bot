// Command handling. Pure with respect to Telegram: takes text, returns reply text.
import { parseWhen, describeRecur, nextOccurrence } from "./parser.js";
import { Store, UserState, newUser } from "./store.js";
import { fmt, fmtTime, dayKey, isValidTz, wallOf, toUtc, addDays } from "./time.js";
import { parseAmount, rupiah } from "./money.js";

export const DEFAULT_TZ = "Asia/Makassar";

export const HELP = `📋 Daftar perintah

⏰ Pengingat
/ingat <kapan> <apa>
   contoh: /ingat besok jam 9 rapat
   /ingat 30 menit lagi angkat jemuran
   /ingat tiap senin jam 8 laporan
/pengingat  daftar pengingat
/hapusingat <no>

📅 Jadwal
/jadwal <kapan> <acara>
   contoh: /jadwal jumat jam 14:00 meeting klien
/hariini  jadwal hari ini
/mingguini  7 hari ke depan
/hapusjadwal <no>

📝 Catatan
/catat <isi>  contoh: /catat wifi kantor di laci
/catatan  daftar catatan
/cari <kata>  contoh: /cari wifi
/hapuscatat <no>

✅ Tugas harian
/tugas <isi>  contoh: /tugas kirim invoice
/tugasku  daftar tugas
/selesai <no>
/hapustugas <no>

💰 Pendapatan
/masuk <jumlah> [keterangan]  contoh: /masuk 50rb VIP, /masuk 1,5jt endorse
/keluar <jumlah> [keterangan]  contoh: /keluar 20rb kuota
/pendapatan  total & rincian hari ini
/hapusmasuk <no>
   Laporan kemarin dikirim otomatis jam 00:00.

☀️ Ringkasan & pengaturan
/ringkas  ringkasan hari ini
/ringkasan <jam>  jam ringkasan pagi (default 7), /ringkasan off
/zona <Area/Kota>  contoh: /zona Asia/Jakarta

💬 Balasan bisnis
Pesan dari orang lain masuk ke sini sebagai draf atau eskalasi.
Tekan ✅ Kirim / ✏️ Edit / ❌ Tolak, atau:
/balas <no> <teks>  contoh: /balas 12 Halo kak, sudah aktif ya
/batal  batalkan balasan yang sedang diketik

🎭 Persona Esse Kuning
/persona  lihat pengaturan sekarang
/setgaya <teks>  contoh: /setgaya santai, panggil "kak", emoji secukupnya
/setlayanan <teks>  /setvip <teks>  /setinfo <teks>
/salam <teks>  salam pembuka (kalimat 18+ selalu ada)
/contoh <chat>  /contohku  /hapuscontoh <no>
/setqr  kirim foto QR dengan caption /setqr untuk mengganti QR pembayaran
/bayarbca  mode bayar transfer BCA   /bayarqris  kembali ke QRIS
/setpricelist  kirim foto pricelist edit dengan caption /setpricelist
/autobalas on|off  default off (semua balasan menunggu persetujuanmu)
/resetpersona  kembali ke default
   Aturan keamanan (konten eksplisit, di bawah umur, harga/bayar/VIP) tidak bisa diubah.

❓ /help  tampilkan daftar ini

Tip: bisa juga pakai bahasa biasa, misal "ingetin besok jam 10 telpon klien" atau "dapet 50rb dari VIP".`;

export class Secretary {
  /** ownerId: only this user may use income commands (undefined = any allowed user, used in tests/console). */
  constructor(private store: Store, private now: () => number = Date.now, private ownerId?: number) {}

  async load(userId: number, chatId: number): Promise<UserState> {
    return (await this.store.get(userId)) ?? newUser(userId, chatId, DEFAULT_TZ);
  }

  async handle(userId: number, chatId: number, text: string): Promise<string> {
    const st = await this.load(userId, chatId);
    st.chatId = chatId;
    const reply = this.dispatch(st, text.trim());
    await this.store.put(st);
    return reply;
  }

  private dispatch(st: UserState, text: string): string {
    const m = text.match(/^\/(\w+)(?:@\w+)?\s*([\s\S]*)$/);
    const cmd = m ? m[1].toLowerCase() : "";
    const arg = m ? m[2].trim() : text;
    const nowMs = this.now();
    const tz = st.tz;

    switch (cmd) {
      case "start": case "help": case "bantuan": return HELP;
      case "batal": return "Tidak ada balasan yang sedang diketik.";
      case "balas": return "Contoh: /balas 12 Halo kak. Nomor ada di pesan draf/eskalasi.";
      case "ingat": case "remind": return this.addReminder(st, arg);
      case "pengingat": case "reminders": return this.listReminders(st);
      case "hapusingat": return this.remove(st, "reminders", arg, "Pengingat");
      case "jadwal": case "event": return this.addEvent(st, arg);
      case "hariini": case "today": return this.agenda(st, 1);
      case "mingguini": case "week": return this.agenda(st, 7);
      case "hapusjadwal": return this.remove(st, "events", arg, "Jadwal");
      case "catat": case "note": {
        if (!arg) return "Tulis isinya, contoh: /catat password wifi kantor ada di laci";
        const id = ++st.seq; st.notes.push({ id, text: arg, created: nowMs });
        return `📝 Catatan #${id} disimpan.`;
      }
      case "catatan": case "notes": return this.listNotes(st, st.notes.slice(-20), "Catatan terbaru");
      case "cari": case "search": {
        if (!arg) return "Contoh: /cari wifi";
        const q = arg.toLowerCase();
        return this.listNotes(st, st.notes.filter(n => n.text.toLowerCase().includes(q)), `Hasil cari "${arg}"`);
      }
      case "hapuscatat": return this.remove(st, "notes", arg, "Catatan");
      case "tugas": case "task": {
        if (!arg) return "Contoh: /tugas kirim invoice";
        const id = ++st.seq; st.tasks.push({ id, text: arg, day: dayKey(nowMs, tz), done: false, created: nowMs });
        return `✅ Tugas #${id} ditambahkan untuk hari ini.`;
      }
      case "tugasku": case "tasks": return this.listTasks(st);
      case "selesai": case "done": {
        const t = st.tasks.find(t => t.id === parseInt(arg.replace("#", "")));
        if (!t) return "Nomor tugas tidak ditemukan. Lihat /tugasku";
        t.done = true; return `👍 Tugas #${t.id} selesai: ${t.text}`;
      }
      case "hapustugas": return this.remove(st, "tasks", arg, "Tugas");
      case "zona": case "tz": {
        if (!arg) return `Zona waktumu: ${tz}. Ubah dengan /zona Asia/Jakarta`;
        if (!isValidTz(arg)) return "Zona waktu tidak dikenal. Contoh: Asia/Jakarta, Asia/Makassar, Asia/Jayapura";
        st.tz = arg; return `🌏 Zona waktu diubah ke ${arg}. Sekarang ${fmt(nowMs, arg)}.`;
      }
      case "ringkasan": {
        if (/^(off|mati)$/i.test(arg)) { st.summaryHour = -1; return "Ringkasan pagi dimatikan."; }
        const h = parseInt(arg);
        if (isNaN(h) || h < 0 || h > 23) return `Ringkasan pagi: ${st.summaryHour < 0 ? "mati" : `jam ${st.summaryHour}:00`}. Ubah: /ringkasan 6`;
        st.summaryHour = h; return `☀️ Ringkasan pagi akan dikirim jam ${h}:00.`;
      }
      case "ringkas": case "summary": return this.summary(st);
      case "masuk": case "keluar": case "pendapatan": case "hapusmasuk":
        if (this.ownerId !== undefined && st.userId !== this.ownerId) return "Perintah ini khusus pemilik.";
        if (cmd === "pendapatan") return this.moneyReport(st, dayKey(nowMs, tz), "💰 Pendapatan hari ini");
        if (cmd === "hapusmasuk") {
          const id = parseInt(arg.replace("#", ""));
          const i = (st.money ?? []).findIndex(x => x.id === id);
          if (i < 0) return `Catatan #${arg || "?"} tidak ditemukan.`;
          const [x] = st.money!.splice(i, 1);
          return `🗑️ #${id} dihapus (${rupiah(x.amount)}${x.note ? " " + x.note : ""}).`;
        }
        return this.addMoney(st, arg, cmd === "masuk" ? "in" : "out");
      case "": {
        if (/^(ingatkan|ingetin|remind)/i.test(text)) return this.addReminder(st, text);
        if (/^(jadwalkan|schedule)/i.test(text)) return this.addEvent(st, text);
        return "Saya belum paham. Ketik /help untuk daftar perintah.";
      }
      default: return "Perintah tidak dikenal. Ketik /help.";
    }
  }

  private addReminder(st: UserState, arg: string): string {
    const p = parseWhen(arg, this.now(), st.tz);
    if (!p) return "Waktunya belum jelas. Contoh: /ingat besok jam 9 rapat, /ingat 15 menit lagi telepon ibu";
    if (!p.text) return "Mau diingatkan soal apa? Contoh: /ingat besok jam 9 rapat";
    if (p.at <= this.now()) return "Waktu itu sudah lewat. Coba waktu lain.";
    const id = ++st.seq;
    st.reminders.push({ id, at: p.at, text: p.text, recur: p.recur });
    const rec = p.recur ? ` (${describeRecur(p.recur)})` : "";
    return `⏰ Siap! Pengingat #${id}: "${p.text}" pada ${fmt(p.at, st.tz)}${rec}.`;
  }

  private addEvent(st: UserState, arg: string): string {
    const p = parseWhen(arg, this.now(), st.tz);
    if (!p || !p.text) return "Contoh: /jadwal besok jam 10 meeting klien";
    const id = ++st.seq;
    st.events.push({ id, at: p.at, text: p.text, hasTime: p.hasTime });
    st.events.sort((a, b) => a.at - b.at);
    return `📅 Jadwal #${id} dicatat: "${p.text}" pada ${fmt(p.at, st.tz)}.`;
  }

  private listReminders(st: UserState): string {
    if (!st.reminders.length) return "Belum ada pengingat.";
    return "⏰ Pengingat:\n" + [...st.reminders].sort((a, b) => a.at - b.at)
      .map(r => `#${r.id} ${fmt(r.at, st.tz)}${r.recur ? ` (${describeRecur(r.recur)})` : ""}: ${r.text}`).join("\n");
  }

  private addMoney(st: UserState, arg: string, kind: "in" | "out"): string {
    const p = parseAmount(arg);
    if (!p) return kind === "in" ? "Contoh: /masuk 50rb VIP, /masuk 1,5jt endorse, /masuk 50.000" : "Contoh: /keluar 20rb kuota";
    const id = ++st.seq;
    const note = p.rest || (kind === "in" ? "lainnya" : "pengeluaran");
    if (!st.money) {
      st.money = [];
      st.lastMoneyReportDay ??= dayKey(toUtc({ ...addDays(wallOf(this.now(), st.tz), -1), h: 12, mi: 0 }, st.tz), st.tz);
    }
    st.money.push({ id, amount: p.amount, note, at: this.now(), kind });
    const total = this.dayTotals(st, dayKey(this.now(), st.tz));
    return `${kind === "in" ? "💰 Masuk" : "💸 Keluar"} #${id}: ${rupiah(p.amount)} (${note}) pada ${fmt(this.now(), st.tz)}.\nTotal masuk hari ini: ${rupiah(total.inSum)}`;
  }

  private dayTotals(st: UserState, day: string) {
    const items = (st.money ?? []).filter(x => dayKey(x.at, st.tz) === day);
    const ins = items.filter(x => x.kind === "in"), outs = items.filter(x => x.kind === "out");
    return { ins, outs, inSum: ins.reduce((a, x) => a + x.amount, 0), outSum: outs.reduce((a, x) => a + x.amount, 0) };
  }

  moneyReport(st: UserState, day: string, title: string): string {
    const t = this.dayTotals(st, day);
    const group = (xs: typeof t.ins) => {
      const g = new Map<string, { n: number; sum: number }>();
      for (const x of xs) { const k = x.note.toLowerCase(); const v = g.get(k) ?? { n: 0, sum: 0 }; v.n++; v.sum += x.amount; g.set(k, v); }
      return [...g].sort((a, b) => b[1].sum - a[1].sum).map(([k, v]) => `• ${k}: ${rupiah(v.sum)} (${v.n}x)`).join("\n");
    };
    const lines = [`${title} (${day})`, `Jumlah transaksi masuk: ${t.ins.length}`, `Total masuk: ${rupiah(t.inSum)}`];
    if (t.ins.length) lines.push("Rincian:\n" + group(t.ins));
    if (t.outs.length) lines.push(`Total keluar: ${rupiah(t.outSum)} (${t.outs.length}x)\n` + group(t.outs), `Bersih: ${rupiah(t.inSum - t.outSum)}`);
    if (t.ins.length || t.outs.length) lines.push("Detail:\n" + [...t.ins, ...t.outs].map(x => `#${x.id} ${fmtTime(x.at, st.tz)} ${x.kind === "in" ? "+" : "-"}${rupiah(x.amount)} ${x.note}`).join("\n"));
    return lines.join("\n");
  }

  agenda(st: UserState, days: number): string {
    const now = this.now();
    const w = wallOf(now, st.tz);
    const start = toUtc({ ...w, h: 0, mi: 0 }, st.tz);
    const end = toUtc({ ...addDays(w, days), h: 0, mi: 0 }, st.tz);
    const ev = st.events.filter(e => e.at >= start && e.at < end);
    const title = days === 1 ? "📅 Jadwal hari ini" : "📅 Jadwal 7 hari ke depan";
    if (!ev.length) return `${title}: kosong.`;
    return `${title}:\n` + ev.map(e => `#${e.id} ${days === 1 ? fmtTime(e.at, st.tz) : fmt(e.at, st.tz)}  ${e.text}`).join("\n");
  }

  private listNotes(st: UserState, notes: UserState["notes"], title: string): string {
    if (!notes.length) return `${title}: tidak ada.`;
    return `📝 ${title}:\n` + notes.map(n => `#${n.id} ${n.text}`).join("\n");
  }

  private listTasks(st: UserState): string {
    const today = dayKey(this.now(), st.tz);
    const open = st.tasks.filter(t => !t.done || t.day === today);
    if (!open.length) return "Tidak ada tugas. Tambah dengan /tugas <isi>";
    return "📋 Tugas:\n" + open.map(t => `${t.done ? "✅" : "⬜"} #${t.id} ${t.text}${t.day < today && !t.done ? " (tertunda)" : ""}`).join("\n");
  }

  summary(st: UserState): string {
    const pending = st.tasks.filter(t => !t.done);
    const today = dayKey(this.now(), st.tz);
    const rem = st.reminders.filter(r => dayKey(r.at, st.tz) === today);
    return [
      `☀️ Selamat pagi! ${fmt(this.now(), st.tz).replace(/ \d\d:\d\d$/, "")}`,
      this.agenda(st, 1),
      rem.length ? "⏰ Pengingat hari ini:\n" + rem.map(r => `${fmtTime(r.at, st.tz)} ${r.text}`).join("\n") : "⏰ Pengingat hari ini: tidak ada.",
      pending.length ? "📋 Tugas belum selesai:\n" + pending.map(t => `⬜ #${t.id} ${t.text}`).join("\n") : "📋 Semua tugas beres.",
    ].join("\n\n");
  }

  private remove(st: UserState, key: "reminders" | "events" | "notes" | "tasks", arg: string, label: string): string {
    const id = parseInt(arg.replace("#", ""));
    const list = st[key] as { id: number }[];
    const i = list.findIndex(x => x.id === id);
    if (i < 0) return `${label} #${arg || "?"} tidak ditemukan.`;
    list.splice(i, 1);
    return `🗑️ ${label} #${id} dihapus.`;
  }

  /**
   * Called by the scheduler (every ~5 min). Returns messages to send.
   * Fires due reminders, reschedules recurring ones, sends the morning summary once per day,
   * and drops events older than 30 days and done tasks older than 7 days.
   */
  async tick(): Promise<{ chatId: number; text: string }[]> {
    const now = this.now();
    const out: { chatId: number; text: string }[] = [];
    for (const uid of await this.store.listUserIds()) {
      const st = await this.store.get(uid);
      if (!st) continue;
      let changed = false;
      for (const r of [...st.reminders]) {
        if (r.at > now) continue;
        const late = now - r.at > 60 * 60e3 ? ` (terlambat, seharusnya ${fmtTime(r.at, st.tz)})` : "";
        out.push({ chatId: st.chatId, text: `⏰ Pengingat: ${r.text}${late}` });
        changed = true;
        if (r.recur) {
          let next = nextOccurrence(r.recur, r.at, st.tz);
          while (next <= now) next = nextOccurrence(r.recur, next, st.tz); // skip missed slots
          r.at = next;
        } else st.reminders = st.reminders.filter(x => x.id !== r.id);
      }
      const w = wallOf(now, st.tz);
      const today = dayKey(now, st.tz);
      if (st.summaryHour >= 0 && w.h >= st.summaryHour && st.lastSummaryDay !== today) {
        out.push({ chatId: st.chatId, text: this.summary(st) });
        st.lastSummaryDay = today; changed = true;
      }
      // Daily income report for the previous local day, sent once, with catch-up if ticks are late.
      if (st.money !== undefined && (this.ownerId === undefined || st.userId === this.ownerId)) {
        if (!st.lastMoneyReportDay) { st.lastMoneyReportDay = dayKey(toUtc({ ...addDays(w, -1), h: 12, mi: 0 }, st.tz), st.tz); changed = true; }
        const yesterday = dayKey(toUtc({ ...addDays(w, -1), h: 12, mi: 0 }, st.tz), st.tz);
        if (st.lastMoneyReportDay < yesterday) {
          out.push({ chatId: st.chatId, text: this.moneyReport(st, yesterday, "📊 Laporan pendapatan kemarin") });
          st.lastMoneyReportDay = yesterday; changed = true;
        }
        const keep = now - 90 * 86400e3;
        if (st.money.some(x => x.at < keep)) { st.money = st.money.filter(x => x.at >= keep); changed = true; }
      }
      const evBefore = st.events.length, tBefore = st.tasks.length;
      st.events = st.events.filter(e => e.at > now - 30 * 86400e3);
      st.tasks = st.tasks.filter(t => !t.done || t.created > now - 7 * 86400e3);
      if (st.events.length !== evBefore || st.tasks.length !== tBefore) changed = true;
      if (changed) await this.store.put(st);
    }
    return out;
  }
}
