/** Gateway local do app WhatsApp MCP (JSON-RPC sem sessão); só responde em 127.0.0.1 da máquina do usuário. */
const WHATSAPP_GATEWAY_URL = 'http://127.0.0.1:47821/mcp';

export function recurrencesMessage(promotions: { name: string; failingLines: string[] }[]): string[] {
  const divergent = promotions.filter((promotion) => promotion.failingLines.length > 0);
  if (divergent.length === 0) return ['Recorrências ok.'];
  return [
    'Recorrências com divergência:',
    ...divergent.flatMap((promotion) => ['', `*${promotion.name}*`, ...promotion.failingLines.map((line) => `- ${line}`)]),
  ];
}

interface ToolCallResponse {
  result?: { isError?: boolean; content?: { type: string; text?: string }[] };
  error?: { message: string };
}

export async function sendWhatsAppMessage(to: string, lines: string[]): Promise<void> {
  const response = await fetch(WHATSAPP_GATEWAY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'send_text_message', arguments: { to, text: lines.join('\n') } },
    }),
    signal: AbortSignal.timeout(60_000),
  }).catch((error: Error) => {
    throw new Error(`app WhatsApp MCP não respondeu em ${WHATSAPP_GATEWAY_URL} (${error.message}). Ele está aberto?`);
  });
  if (!response.ok) throw new Error(`app WhatsApp MCP respondeu HTTP ${response.status}.`);

  const { result, error } = (await response.json()) as ToolCallResponse;
  if (error) throw new Error(error.message);
  if (result?.isError) {
    const text = result.content?.find((item) => item.type === 'text')?.text ?? '';
    let detail = text;
    try {
      detail = (JSON.parse(text) as { error?: string }).error ?? text;
    } catch {}
    throw new Error(detail || 'envio recusado pelo app WhatsApp MCP.');
  }
}
