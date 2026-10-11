import { mulaw } from "alawmulaw";

function upsample(samples: Int16Array, fromRate: number, toRate: number): Int16Array {
  const ratio = toRate / fromRate;
  const output = new Int16Array(Math.floor(samples.length * ratio));
  for (let i = 0; i < output.length; i++) {
    const srcIdx = i / ratio;
    const lo = Math.floor(srcIdx);
    const hi = Math.min(lo + 1, samples.length - 1);
    const frac = srcIdx - lo;
    output[i] = Math.round(samples[lo] * (1 - frac) + samples[hi] * frac);
  }
  return output;
}

// Twilio μ-law 8kHz base64 → PCM16 16kHz base64 (Gemini input format)
export function twilioToGemini(base64Mulaw: string): string {
  const mulawBytes = new Uint8Array(Buffer.from(base64Mulaw, "base64"));
  const pcm8k = mulaw.decode(mulawBytes);
  const pcm16k = upsample(pcm8k, 8000, 16000);
  return Buffer.from(pcm16k.buffer).toString("base64");
}

// Gemini PCM16 24kHz base64 → Twilio μ-law 8kHz base64
// Per-call converter: Gemini chunks are not always a multiple of 3 samples, so leftover samples are
// carried into the next chunk. Dropping them would leave a tiny gap (a click) at every chunk boundary.
export function createGeminiToTwilio(): (base64Pcm24k: string) => string {
  let carry: number[] = [];
  return (base64Pcm24k: string): string => {
    const raw = Buffer.from(base64Pcm24k, "base64");
    const samples = new Int16Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + (raw.byteLength & ~1)));
    const all = carry.length ? Int16Array.from([...carry, ...samples]) : samples;
    const usable = all.length - (all.length % 3);
    carry = Array.from(all.subarray(usable));
    // 24 kHz -> 8 kHz: average each group of 3 samples (a simple low-pass) instead of dropping 2 of 3
    const pcm8k = new Int16Array(usable / 3);
    for (let i = 0; i < pcm8k.length; i++) {
      pcm8k[i] = Math.round((all[i * 3] + all[i * 3 + 1] + all[i * 3 + 2]) / 3);
    }
    return Buffer.from(mulaw.encode(pcm8k)).toString("base64");
  };
}

// Stateless version, kept for callers that convert a single complete buffer
export function geminiToTwilio(base64Pcm24k: string): string {
  return createGeminiToTwilio()(base64Pcm24k);
}
