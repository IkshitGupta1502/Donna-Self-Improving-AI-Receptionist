import { Router, Request, Response, NextFunction } from "express";
import twilio from "twilio";
import { config } from "../config";
import { buildStreamTwiml } from "../utils/twiml";

export const voiceRouter = Router();

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

voiceRouter.post("/", validateTwilioSignature, (req: Request, res: Response): void => {
  const host = config.PUBLIC_HOST ?? req.headers.host ?? "";
  res.type("text/xml").send(buildStreamTwiml(host));
});
