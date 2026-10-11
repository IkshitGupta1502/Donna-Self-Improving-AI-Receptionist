import { FunctionDeclaration, Type } from "@google/genai";
import type { CustomerPatch, DataStore, Speed } from "../data/store";

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
  {
    name: "update_customer_profile",
    description:
      "Save or update what we know about the current caller (matched by their caller ID). Use when they tell you their name or email, or a preference worth remembering. Notes are appended, other fields are replaced.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        name: { type: Type.STRING, description: "Caller's name" },
        email: { type: Type.STRING, description: "Caller's email address" },
        preferences: { type: Type.STRING, description: "Standing preferences, e.g. light starch on shirts" },
        notes: { type: Type.STRING, description: "A short note for staff to remember about this customer" },
      },
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
  store: DataStore,
  ctx: { callerPhone?: string } = {}
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

    case "update_customer_profile": {
      if (!ctx.callerPhone) return { error: "No caller phone number is available for this call." };
      const patch: CustomerPatch = {
        name: str(args, "name") || undefined,
        email: str(args, "email") || undefined,
        preferences: str(args, "preferences") || undefined,
      };
      const note = str(args, "notes");
      if (note) {
        const existing = await store.getCustomerByPhone(ctx.callerPhone);
        const dated = `[${new Date().toISOString().slice(0, 10)}] ${note}`;
        patch.notes = [existing?.notes, dated].filter(Boolean).join(" ");
      }
      if (!patch.name && !patch.email && !patch.preferences && !patch.notes) {
        return { error: "Provide at least one of name, email, preferences, or notes." };
      }
      const saved = await store.upsertCustomer(ctx.callerPhone, patch);
      return { saved: true, customer: saved };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}
