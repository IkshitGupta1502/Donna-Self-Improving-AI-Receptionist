import { FunctionDeclaration, Type } from "@google/genai";
import type { CustomTool, DataStore, Speed } from "../data/store";

export const TOOLS: FunctionDeclaration[] = [
  {
    name: "get_order",
    description:
      "Look up an order. Use when the caller gives an order number (like ORD-0010), their name, or the phone number. Pass exactly one of orderId, customerName, or phone. Always call this before stating any order detail.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        orderId: { type: Type.STRING, description: "Order number, e.g. ORD-0010" },
        customerName: { type: Type.STRING, description: "Customer name or part of it" },
        phone: { type: Type.STRING, description: "Phone number, e.g. +14155550123" },
      },
    },
  },
  {
    name: "lookup_price",
    description:
      "Get the price for one garment at a given speed. Use when the caller asks what something costs or what expedited costs more. Item must match the pricing list name; call list_prices if unsure.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        item: { type: Type.STRING, description: "Garment name from the pricing list, e.g. Suit (2-piece)" },
        speed: {
          type: Type.STRING,
          enum: ["Regular", "Expedited"],
          description: "Regular or Expedited",
        },
      },
      required: ["item", "speed"],
    },
  },
  {
    name: "list_prices",
    description:
      "Return the full price list. Use when the caller asks for general prices or for the exact name of an item.",
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: "add_order_note",
    description:
      "Write a note on an existing order. Use to record special handling requests such as delicate fabric, no starch, or stain details. Look up the order first so you have its orderId.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        orderId: { type: Type.STRING, description: "Order number, e.g. ORD-0010" },
        note: { type: Type.STRING, description: "The note to save, short and specific" },
      },
      required: ["orderId", "note"],
    },
  },
  {
    name: "take_message",
    description:
      "Save a message for staff to call back. Use when the caller asks for a human, has a question you cannot answer from the tools, or wants a callback. Get the caller's name, callback number, and message before calling.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        name: { type: Type.STRING, description: "Caller's name" },
        phone: { type: Type.STRING, description: "Callback phone number" },
        message: { type: Type.STRING, description: "What the caller needs staff to know" },
      },
      required: ["name", "phone", "message"],
    },
  },
];

type Args = Record<string, unknown>;

function str(args: Args, key: string): string {
  const v = args[key];
  return typeof v === "string" ? v.trim() : "";
}

export async function executeTool(
  name: string,
  args: Args,
  store: DataStore
): Promise<Record<string, unknown>> {
  switch (name) {
    case "get_order": {
      const orderId = str(args, "orderId");
      const customerName = str(args, "customerName");
      const phone = str(args, "phone");
      if (orderId) {
        const order = await store.getOrderById(orderId);
        return { found: !!order, orders: order ? [order] : [] };
      }
      if (phone) {
        const orders = await store.getOrdersByPhone(phone);
        return { found: orders.length > 0, orders };
      }
      if (customerName) {
        const orders = await store.searchOrdersByName(customerName);
        return { found: orders.length > 0, orders };
      }
      return { error: "Provide orderId, customerName, or phone." };
    }

    case "lookup_price": {
      const item = str(args, "item");
      const speed: Speed = str(args, "speed") === "Expedited" ? "Expedited" : "Regular";
      if (!item) return { error: "Provide the item name." };
      return { ...(await store.lookupPrice(item, speed)) };
    }

    case "list_prices": {
      const prices = await store.listPrices();
      return { prices };
    }

    case "add_order_note": {
      const orderId = str(args, "orderId");
      const note = str(args, "note");
      if (!orderId || !note) return { error: "Provide orderId and note." };
      const order = await store.appendOrderNote(orderId, note);
      if (!order) return { saved: false, error: `No order ${orderId}.` };
      return { saved: true, orderId: order.orderId, notes: order.notes };
    }

    case "take_message": {
      const callerName = str(args, "name");
      const phone = str(args, "phone");
      const message = str(args, "message");
      if (!callerName || !phone || !message) {
        return { error: "Provide name, phone, and message." };
      }
      const saved = await store.takeMessage({ name: callerName, phone, message });
      return { saved: true, message: saved };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ---- Custom tools -----------------------------------------------------------------------------
// Requested by the teacher, built by the CRM owner, enabled by the owner with an https endpoint.
// The bridge only forwards declared arguments to that endpoint and never lets a custom tool shadow a built-in.

const BUILT_IN = new Set(TOOLS.map((t) => t.name));
const TYPE_MAP = { string: Type.STRING, number: Type.NUMBER, integer: Type.INTEGER, boolean: Type.BOOLEAN } as const;
const CUSTOM_TIMEOUT_MS = 5000;
const MAX_RESPONSE_CHARS = 8000;

export function usableCustomTools(tools: CustomTool[]): CustomTool[] {
  return tools.filter((t) => !BUILT_IN.has(t.name));
}

export function customDeclarations(tools: CustomTool[]): FunctionDeclaration[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: {
      type: Type.OBJECT,
      properties: Object.fromEntries(t.parameters.map((p) => [p.name, { type: TYPE_MAP[p.type], description: p.description }])),
      required: t.parameters.filter((p) => p.required).map((p) => p.name),
    },
  }));
}

export async function executeCustomTool(tool: CustomTool, args: Args): Promise<Record<string, unknown>> {
  const declared = new Set(tool.parameters.map((p) => p.name));
  const clean = Object.fromEntries(Object.entries(args).filter(([k]) => declared.has(k)));
  const missing = tool.parameters.filter((p) => p.required && clean[p.name] === undefined).map((p) => p.name);
  if (missing.length) return { error: `Missing: ${missing.join(", ")}` };
  const secret = process.env.CUSTOM_TOOL_SECRET;
  try {
    const res = await fetch(tool.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...(secret ? { "x-tool-secret": secret } : {}) },
      body: JSON.stringify({ tool: tool.name, args: clean }),
      signal: AbortSignal.timeout(CUSTOM_TIMEOUT_MS),
    });
    const text = (await res.text()).slice(0, MAX_RESPONSE_CHARS);
    if (!res.ok) return { error: `${tool.name} failed with HTTP ${res.status}` };
    try {
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { result: parsed };
    } catch {
      return { result: text };
    }
  } catch (err) {
    return { error: `${tool.name} unavailable: ${err instanceof Error ? err.message : String(err)}` };
  }
}
