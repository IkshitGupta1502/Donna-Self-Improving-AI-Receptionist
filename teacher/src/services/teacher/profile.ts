// The receptionist is given the caller's profile (from caller ID) before it picks up. The judge has to see the same
// thing, otherwise correct behaviour such as greeting a known caller by name looks like an invented fact.
type Doc = Record<string, any>;

const e164 = (phone: string): string => {
  const digits = phone.replace(/\D/g, "");
  return digits.length === 10 ? `+1${digits}` : `+${digits}`;
};

export function formatCallerProfile(customer: Doc | null, orders: Doc[]): string {
  if (!customer && orders.length === 0) return "(no profile: this number was not recognised, so the receptionist did not know the caller)";
  const lines: string[] = [];
  if (customer?.name) lines.push(`Name: ${customer.name}${customer.vip ? " (VIP)" : ""}`);
  if (customer?.email) lines.push(`Email: ${customer.email}`);
  if (customer?.preferences) lines.push(`Preferences: ${customer.preferences}`);
  if (customer?.notes) lines.push(`Notes from staff: ${customer.notes}`);
  if (customer && customer.callCount > 0) lines.push(`Previous calls: ${customer.callCount}`);
  for (const o of orders) {
    lines.push(`Order ${o.orderId}: ${o.garment}, ${o.stage}, ${o.orderType}, $${o.price}, payment ${o.payment}, expected ${o.expectedDate}${o.notes ? `, note: ${o.notes}` : ""}`);
  }
  return lines.join("\n");
}

export async function callerProfileText(
  cols: { customers: { findOne(q: Doc): Promise<Doc | null> }; orders: { find(q: Doc): { limit(n: number): { toArray(): Promise<Doc[]> } } } },
  from: string | undefined
): Promise<string> {
  if (!from) return "(no caller ID on this call)";
  try {
    const phone = e164(from);
    const [customer, orders] = await Promise.all([
      cols.customers.findOne({ phone }),
      cols.orders.find({ phone }).limit(5).toArray(),
    ]);
    return formatCallerProfile(customer, orders);
  } catch {
    return "(profile unavailable)";
  }
}
