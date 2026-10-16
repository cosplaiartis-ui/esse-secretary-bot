// Storage: one JSON document per user. Single-user scale, so this stays simple.
import type { Recurrence } from "./parser.js";

export interface Reminder { id: number; at: number; text: string; recur?: Recurrence; }
export interface Event { id: number; at: number; text: string; hasTime: boolean; }
export interface Note { id: number; text: string; created: number; }
export interface Task { id: number; text: string; day: string; done: boolean; created: number; }

export interface Money { id: number; amount: number; note: string; at: number; kind: "in" | "out"; }

export interface Pending {
  id: number;
  kind: "approval" | "escalation";
  contactName: string;
  contactChatId: number;
  businessConnectionId?: string;
  incoming: string;
  draft?: string;
  reason?: string;
  created: number;
}

export interface UserState {
  userId: number;
  chatId: number;
  tz: string;
  summaryHour: number;       // local hour for the daily morning summary
  lastSummaryDay?: string;   // YYYY-MM-DD of the last summary sent
  seq: number;
  reminders: Reminder[];
  events: Event[];
  notes: Note[];
  tasks: Task[];
  pending?: Pending[];        // persona drafts/escalations awaiting the owner
  awaitingReplyFor?: number;
  seenContacts?: number[];
  money?: Money[];            // owner-only income/expense log
  lastMoneyReportDay?: string; // YYYY-MM-DD (local) of the last day whose report was sent    // chat ids that already got the age gate  // pending id whose reply the owner is typing
}

export function newUser(userId: number, chatId: number, tz: string): UserState {
  return { userId, chatId, tz, summaryHour: 7, seq: 0, reminders: [], events: [], notes: [], tasks: [] };
}

export interface Store {
  get(userId: number): Promise<UserState | null>;
  put(s: UserState): Promise<void>;
  listUserIds(): Promise<number[]>;
}

export class MemoryStore implements Store {
  private m = new Map<number, string>();
  async get(id: number) { const v = this.m.get(id); return v ? (JSON.parse(v) as UserState) : null; }
  async put(s: UserState) { this.m.set(s.userId, JSON.stringify(s)); }
  async listUserIds() { return [...this.m.keys()]; }
}

/** Upstash Redis over REST (works in serverless; no TCP connection pooling needed). */
export class RedisStore implements Store {
  constructor(private url: string, private token: string, private prefix = "sec:") {}
  private async cmd<T>(...args: (string | number)[]): Promise<T> {
    const r = await fetch(this.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
    if (!r.ok) throw new Error(`redis ${r.status}`);
    const j = (await r.json()) as { result: T; error?: string };
    if (j.error) throw new Error(j.error);
    return j.result;
  }
  async get(id: number) {
    const v = await this.cmd<string | null>("GET", `${this.prefix}user:${id}`);
    return v ? (JSON.parse(v) as UserState) : null;
  }
  async put(s: UserState) {
    await this.cmd("SET", `${this.prefix}user:${s.userId}`, JSON.stringify(s));
    await this.cmd("SADD", `${this.prefix}users`, s.userId);
  }
  async listUserIds() {
    return (await this.cmd<string[]>("SMEMBERS", `${this.prefix}users`)).map(Number);
  }
}

export function storeFromEnv(): Store {
  // Vercel Marketplace (Upstash) injects KV_REST_API_*; plain Upstash uses UPSTASH_REDIS_REST_*.
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (url && token) return new RedisStore(url, token);
  if (process.env.VERCEL) throw new Error("No Redis configured (UPSTASH_REDIS_REST_URL/TOKEN)");
  return getMemory();
}
let mem: MemoryStore | undefined;
const getMemory = () => (mem ??= new MemoryStore());
