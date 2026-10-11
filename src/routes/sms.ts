import { Router, Request, Response, NextFunction } from "express";
import twilio from "twilio";
import { config } from "../config";
import { buildMessageTwiml } from "../utils/twiml";
import { getStore } from "../services/gemini/liveSession";

export const smsRouter = Router();

function validateTwilioSignature(req: Request, res: Response, next: NextFunction): void {
  if (!config.TWILIO_AUTH_TOKEN) {
    next();
    return;
  }

  const host = config.PUBLIC_HOST ?? req.headers.host ?? "";
  const url = `https://${host}${req.originalUrl}`;
  const signature = req.headers["x-twilio-signature"];
  const valid =
    typeof signature === "string" &&
    twilio.validateRequest(config.TWILIO_AUTH_TOKEN, signature, url, req.body);

  if (!valid) {
    res.status(403).send("Forbidden");
    return;
  }

  next();
}

const ORDER_ID = /^ORD-\d+$/i;

// A text that just arrived at the business number. Looking up an order by its
// id is handled here directly; anything else is saved the same way a caller
// asking for staff on a call would be (DataStore.takeMessage).
smsRouter.post("/", validateTwilioSignature, (req: Request, res: Response): void => {
  const from = typeof req.body?.From === "string" ? req.body.From : "";
  const text = typeof req.body?.Body === "string" ? req.body.Body.trim() : "";
  res.type("text/xml");

  if (!from || !text) {
    res.send(buildMessageTwiml("Sorry, we couldn't read that message."));
    return;
  }

  void (async () => {
    try {
      const store = await getStore();
      if (ORDER_ID.test(text)) {
        const order = await store.getOrderById(text.toUpperCase());
        if (!order) {
          res.send(buildMessageTwiml(`We couldn't find order ${text.toUpperCase()}.`));
          return;
        }
        const due = order.price > 0 ? `, $${order.price.toFixed(2)} ${order.payment === "Unpaid" ? "due" : "(" + order.payment + ")"}` : "";
        res.send(buildMessageTwiml(`${order.orderId}: ${order.garment} — ${order.stage}${due}. Ready ${order.expectedDate}.`));
        return;
      }
      await store.takeMessage({ name: "Text message", phone: from, message: text });
      res.send(buildMessageTwiml("Got it, thanks! Staff will follow up. Text an order number (like ORD-0007) any time for a status update."));
    } catch (err) {
      console.error("[sms] inbound handling failed:", err);
      res.send(buildMessageTwiml("Sorry, something went wrong on our end. Please call us instead."));
    }
  })();
});
