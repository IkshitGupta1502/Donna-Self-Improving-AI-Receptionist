import { MongoClient, type Collection, type OptionalUnlessRequiredId } from "mongodb";
import { SEED_ORDERS, SEED_PRICING } from "./seed";

export type Speed = "Regular" | "Expedited";

export interface Order {
  orderId: string;
  customerName: string;
  phone: string;
  garment: string;
  stage: string;
  orderType: Speed;
  price: number;
  payment: string;
  notes: string;
  expectedDate: string;
}

export interface PriceRow {
  category: string;
  item: string;
  regularPrice: number;
  expeditedPrice: number;
  notes: string;
}

export interface PriceLookup {
  found: boolean;
  item: string;
  orderType: Speed;
  price: number | null;
  category: string | null;
  notes: string | null;
}

export interface Message {
  name: string;
  phone: string;
  message: string;
  createdAt: string;
}

export interface CallTranscriptEntry {
  role: "caller" | "agent";
  text: string;
  ts: string;
}

export interface CallToolCall {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  ts: string;
}

export interface CallRecord {
  callSid: string;
  from?: string;
  startedAt: string;
  endedAt?: string;
  durationSec?: number;
  transcript: CallTranscriptEntry[];
  toolCalls: CallToolCall[];
  status: "active" | "completed";
}

export interface DataStore {
  getOrderById(orderId: string): Promise<Order | null>;
  searchOrdersByName(name: string): Promise<Order[]>;
  getOrdersByPhone(phone: string): Promise<Order[]>;
  listPrices(): Promise<PriceRow[]>;
  lookupPrice(item: string, speed: Speed): Promise<PriceLookup>;
  appendOrderNote(orderId: string, note: string): Promise<Order | null>;
  takeMessage(input: { name: string; phone: string; message: string }): Promise<Message>;
  saveCall(record: CallRecord): Promise<void>;
  listCalls(limit: number): Promise<CallRecord[]>;
  listOrders(): Promise<Order[]>;
  listMessages(): Promise<Message[]>;
}

export function normalizePhone(input: string): string {
  const digits = input.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  return `+${digits}`;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toLookup(item: string, speed: Speed, row: PriceRow | undefined): PriceLookup {
  return {
    found: !!row,
    item,
    orderType: speed,
    price: row ? (speed === "Expedited" ? row.expeditedPrice : row.regularPrice) : null,
    category: row?.category ?? null,
    notes: row?.notes || null,
  };
}

export function createMemoryStore(): DataStore {
  const orders: Order[] = structuredClone(SEED_ORDERS);
  const pricing: PriceRow[] = structuredClone(SEED_PRICING);
  const messages: Message[] = [];
  const calls = new Map<string, CallRecord>();
  const findOrder = (orderId: string) => {
    const id = orderId.trim().toUpperCase();
    return orders.find((o) => o.orderId.toUpperCase() === id) ?? null;
  };

  return {
    async getOrderById(orderId) {
      return findOrder(orderId);
    },
    async searchOrdersByName(name) {
      const q = name.trim().toLowerCase();
      return orders.filter((o) => o.customerName.toLowerCase().includes(q)).slice(0, 5);
    },
    async getOrdersByPhone(phone) {
      const p = normalizePhone(phone);
      return orders.filter((o) => normalizePhone(o.phone) === p).slice(0, 5);
    },
    async listPrices() {
      return pricing.map((r) => ({ ...r }));
    },
    async lookupPrice(item, speed) {
      const q = item.trim().toLowerCase();
      const row =
        pricing.find((r) => r.item.toLowerCase() === q) ??
        pricing.find((r) => r.item.toLowerCase().includes(q) || q.includes(r.item.toLowerCase()));
      return toLookup(item, speed, row);
    },
    async appendOrderNote(orderId, note) {
      const order = findOrder(orderId);
      if (!order) return null;
      const line = `[${today()}] ${note.trim()}`;
      order.notes = order.notes ? `${order.notes} ${line}` : line;
      return { ...order };
    },
    async takeMessage(input) {
      const msg: Message = {
        name: input.name.trim(),
        phone: normalizePhone(input.phone),
        message: input.message.trim(),
        createdAt: new Date().toISOString(),
      };
      messages.push(msg);
      return { ...msg };
    },
    async saveCall(record) {
      calls.set(record.callSid, structuredClone(record));
    },
    async listCalls(limit) {
      return [...calls.values()]
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, limit)
        .map((c) => structuredClone(c));
    },
    async listOrders() {
      return structuredClone(orders);
    },
    async listMessages() {
      return [...messages].reverse().map((m) => ({ ...m }));
    },
  };
}

async function seedIfEmpty<T extends object>(col: Collection<T>, docs: T[]): Promise<void> {
  if ((await col.estimatedDocumentCount()) > 0 || docs.length === 0) return;
  await col.insertMany(docs.map((d) => ({ ...d })) as OptionalUnlessRequiredId<T>[], { ordered: false }).catch((err: unknown) => {
    if ((err as { code?: number })?.code !== 11000) throw err;
  });
}

export async function createMongoStore(uri: string, dbName: string): Promise<DataStore> {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);
  const orders = db.collection<Order>("orders");
  const pricing = db.collection<PriceRow>("pricing");
  const messages = db.collection<Message>("messages");
  const calls = db.collection<CallRecord>("calls");

  await orders.createIndex({ orderId: 1 }, { unique: true });
  await pricing.createIndex({ item: 1 }, { unique: true });
  await calls.createIndex({ callSid: 1 }, { unique: true });
  await seedIfEmpty(orders, SEED_ORDERS);
  await seedIfEmpty(pricing, SEED_PRICING);
  console.log(`[data] MongoDB connected: db=${dbName}`);

  const proj = { projection: { _id: 0 } } as const;

  return {
    async getOrderById(orderId) {
      const id = orderId.trim().toUpperCase();
      return orders.findOne({ orderId: id }, proj);
    },
    async searchOrdersByName(name) {
      return orders
        .find({ customerName: { $regex: escapeRegex(name.trim()), $options: "i" } }, proj)
        .limit(5)
        .toArray();
    },
    async getOrdersByPhone(phone) {
      return orders.find({ phone: normalizePhone(phone) }, proj).limit(5).toArray();
    },
    async listPrices() {
      return pricing.find({}, proj).sort({ category: 1, item: 1 }).toArray();
    },
    async lookupPrice(item, speed) {
      const row = await pricing.findOne(
        { item: { $regex: `^${escapeRegex(item.trim())}$`, $options: "i" } },
        proj
      ) ?? await pricing.findOne(
        { item: { $regex: escapeRegex(item.trim()), $options: "i" } },
        proj
      );
      return toLookup(item, speed, row ?? undefined);
    },
    async appendOrderNote(orderId, note) {
      const line = `[${today()}] ${note.trim()}`;
      const res = await orders.updateOne({ orderId: orderId.trim().toUpperCase() }, [
        {
          $set: {
            notes: {
              $cond: [
                { $gt: [{ $strLenCP: { $ifNull: ["$notes", ""] } }, 0] },
                { $concat: [{ $ifNull: ["$notes", ""] }, " ", { $literal: line }] },
                { $literal: line },
              ],
            },
          },
        },
      ]);
      if (res.matchedCount === 0) return null;
      return orders.findOne({ orderId: orderId.trim().toUpperCase() }, proj);
    },
    async takeMessage(input) {
      const doc: Message = {
        name: input.name.trim(),
        phone: normalizePhone(input.phone),
        message: input.message.trim(),
        createdAt: new Date().toISOString(),
      };
      await messages.insertOne({ ...doc });
      return doc;
    },
    async saveCall(record) {
      await calls.replaceOne({ callSid: record.callSid }, structuredClone(record), { upsert: true });
    },
    async listCalls(limit) {
      return calls.find({}, proj).sort({ startedAt: -1 }).limit(limit).toArray();
    },
    async listOrders() {
      return orders.find({}, proj).sort({ orderId: 1 }).toArray();
    },
    async listMessages() {
      return messages.find({}, proj).sort({ createdAt: -1 }).toArray();
    },
  };
}

export async function createDataStore(): Promise<DataStore> {
  const uri = process.env.MONGODB_URI?.trim();
  if (!uri) {
    console.log("[data] MONGODB_URI unset, using in-memory store");
    return createMemoryStore();
  }
  return createMongoStore(uri, process.env.MONGODB_DB?.trim() || "snoopy");
}
