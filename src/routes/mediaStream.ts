import WebSocket from "ws";
import { openGeminiSession } from "../services/gemini/liveSession";

interface TwilioFrame {
  event: string;
  start?: { callSid: string; streamSid: string };
  media?: { payload: string };
}

type GeminiHandle = Awaited<ReturnType<typeof openGeminiSession>>;

export function handleMediaStream(ws: WebSocket): void {
  let callSid: string | null = null;
  let streamSid: string | null = null;
  let gemini: GeminiHandle | null = null;
  let closed = false;

  function teardown(): void {
    if (closed) return;
    closed = true;
    const handle = gemini;
    gemini = null;
    handle?.close();
  }

  ws.on("message", async (raw: WebSocket.RawData) => {
    let frame: TwilioFrame;
    try {
      frame = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (frame.event) {
      case "start": {
        if (!frame.start) return;
        callSid = frame.start.callSid;
        streamSid = frame.start.streamSid;
        console.log(`[${callSid}] media stream started`);

        const handle = await openGeminiSession({
          onAudio: (base64Mulaw: string) => {
            if (ws.readyState === WebSocket.OPEN && streamSid) {
              ws.send(JSON.stringify({ event: "media", streamSid, media: { payload: base64Mulaw } }));
            }
          },
          onError: (err) => {
            console.error(`[${callSid}] Gemini error:`, err);
            ws.close();
          },
          onClose: () => ws.close(),
        }).catch((err) => {
          console.error(`[${callSid}] Failed to open Gemini session:`, err);
          ws.close();
          return null;
        });

        if (!handle) return;
        if (closed) {
          handle.close();
          return;
        }
        gemini = handle;
        return;
      }

      case "media":
        if (frame.media && gemini) gemini.sendAudio(frame.media.payload);
        return;

      case "stop":
        console.log(`[${callSid}] media stream stopped`);
        teardown();
        ws.close();
        return;

      default:
        // "connected", "mark" and "clear" need no action
        return;
    }
  });

  ws.on("close", () => teardown());

  ws.on("error", (err) => {
    console.error("MediaStream WS error:", err.message);
    teardown();
  });
}
