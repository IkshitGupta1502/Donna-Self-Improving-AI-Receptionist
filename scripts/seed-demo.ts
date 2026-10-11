// Seeds demo data for the Charlie's Cleaners demo: `npm run seed` (uses MONGODB_URI if set, else a dry run in memory).
// Safe to re-run: orders are upserted by orderId, and the demo context version is added only once.
import dotenv from "dotenv";
import { createDataStore, normalizePhone } from "../src/services/data/store";

dotenv.config();

const phoneArg = process.argv.find((a) => a.startsWith("--phone="))?.split("=")[1];
const PHONE = normalizePhone(phoneArg ?? "925-551-1546");
const NAME = "Aayush Gandhi";

const DEMO_CONTEXT = [
  "Charlie's Cleaners is a friendly neighborhood dry cleaner.",
  "Services: dry cleaning, laundry and press, alterations and repairs, wedding gown and leather care, and household items like comforters and curtains.",
  "Turnaround: regular service takes 3 days. Expedited service is ready the next day for an extra fee.",
  "Pickup hours: Monday to Saturday, 8am to 6pm. Closed on Sunday and major holidays.",
  "Location: 123 Main Street (demo address). Free parking behind the building.",
  "Payment: we accept cash, credit and debit cards, and Apple Pay. Payment is due at pickup. We do not take card numbers over the phone.",
  "Pickup and delivery: free home pickup and delivery for orders over $40, within 5 miles. Otherwise a $6 fee. Schedule through staff.",
  "Alterations: hems, tapering and zipper repair are done in-house and take 3 to 5 days. Staff quote the price after seeing the garment.",
  "Special items such as leather, suede, beaded or vintage garments need staff to inspect them. Take a message and staff will call back with a quote.",
  "Stains: tell us about stains at drop-off so we can treat them. We cannot guarantee every stain will come out.",
  "Damage policy: if an item is damaged in our care, staff will review it and make it right. Take a message so a manager can call back.",
  "Unclaimed items are held for 30 days.",
  "Tone: warm, neighborly, and brief. Be patient with callers and never pushy.",
  "For anything not listed here, take a message and let the caller know staff will call back.",
].join("\n");

async function main(): Promise<void> {
  const store = await createDataStore();

  const orders = [
    { orderId: "ORD-0101", customerName: NAME, phone: PHONE, garment: "Suit (2-piece)", stage: "Ready for Pickup", orderType: "Regular" as const, price: 24, payment: "Unpaid", notes: "Please press the lapels.", expectedDate: "2026-10-11" },
    { orderId: "ORD-0102", customerName: NAME, phone: PHONE, garment: "Wool Coat", stage: "Cleaning", orderType: "Expedited" as const, price: 48, payment: "Card", notes: "", expectedDate: "2026-10-12" },
    { orderId: "ORD-0103", customerName: NAME, phone: PHONE, garment: "Comforter (queen)", stage: "Received", orderType: "Regular" as const, price: 30, payment: "Unpaid", notes: "Small coffee stain near one corner.", expectedDate: "2026-10-14" },
  ];
  for (const o of orders) await store.upsertOrder(o);
  console.log(`✓ Upserted ${orders.length} demo orders for ${PHONE} (${NAME})`);

  const versions = await store.listConfigVersions();
  if (versions.some((v) => v.note === "Demo context")) {
    console.log("✓ Demo context version already present, skipping");
  } else {
    const active = await store.getActiveConfig();
    const saved = await store.saveConfigVersion({
      companyName: active.companyName,
      greeting: active.greeting,
      context: DEMO_CONTEXT,
      author: "system",
      note: "Demo context",
    });
    console.log(`✓ Added demo company context as v${saved.version} (now active; roll back from the dashboard if needed)`);
  }

  const all = await store.listOrders();
  console.log(`\nOrders in database: ${all.length}. Orders for ${PHONE}: ${all.filter((o) => normalizePhone(o.phone) === PHONE).length}`);
  console.log(`Call from ${PHONE} and say "where's my order?" and the agent will find these.\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error("✗", err instanceof Error ? err.message : err);
  process.exit(1);
});
