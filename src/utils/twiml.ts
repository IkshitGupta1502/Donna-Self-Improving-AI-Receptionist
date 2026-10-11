function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function buildStreamTwiml(host: string, callerPhone?: string): string {
  const param = callerPhone ? `<Parameter name="from" value="${escapeXml(callerPhone)}"/>` : "";
  return `<Response><Connect><Stream url="wss://${host}/media-stream">${param}</Stream></Connect></Response>`;
}
