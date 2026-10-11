export function buildStreamTwiml(host: string): string {
  return `<Response><Connect><Stream url="wss://${host}/media-stream"/></Connect></Response>`;
}
