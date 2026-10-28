import type { IncomingMessage, ServerResponse } from 'node:http';
import { readAtendimentosResult, runAtendimentosScanStreaming } from './atendimentos-scan.ts';
import {
  hasRecurrencesScanResult,
  hasRecurrencesSession,
  lastRecurrencesMessage,
  lastScannedPanelUrls,
  runRecurrencesRefreshStreaming,
  runRecurrencesScanStreaming,
  sendRecurrencesWhatsApp,
} from './recurrences-scan.ts';
import { warmLabelEmbeddings } from './atendimento-classifier.ts';
import { isSeverity, listAtendimentoLabels, saveAtendimentoLabel } from './atendimento-labels.ts';
import { rememberSummary, summarizeAtendimentos, summaryWhatsAppLines, type AtendimentosSummaryEvent } from './atendimentos-summary.ts';
import { getAuthenticatedUserId } from './auth.ts';
import { getPromoMonitorConnection } from './connectors-store.ts';
import { readJsonBody, sendJson } from './http-utils.ts';
import { durationDetail, promotionsScanDetails, recordLog, type LogDetails } from './logs.ts';
import { getScheduleStatus, setScheduleEnabled } from './recurrences-schedule.ts';

const ROUTES = ['/api/recurrences/scan', '/api/recurrences/atendimentos', '/api/recurrences/refresh', '/api/recurrences/whatsapp', '/api/recurrences/message'];

function logManual(
  userId: string,
  action: string,
  startedAt: number,
  result: { success: true } | { success: false; error: string },
  okMessage: string,
  details?: LogDetails,
): void {
  const message = result.success ? okMessage : (result.error.split('\n')[0] ?? '');
  recordLog({ source: 'recorrencias', trigger: 'manual', userId, action, ok: result.success, message, details: { ...details, duracao: durationDetail(startedAt) } });
}

/** Chamador já garantiu `requireAuth`. */
export async function handleRecurrencesRoute(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
  if (pathname === '/api/recurrences/schedule') {
    if (req.method === 'GET') return sendJson(res, 200, getScheduleStatus());
    if (req.method !== 'PUT') return sendJson(res, 404, { error: 'Rota de recorrências desconhecida.' });
    const body = (await readJsonBody(req)) as { enabled?: unknown };
    try {
      return sendJson(res, 200, await setScheduleEnabled(body.enabled === true, getAuthenticatedUserId(req)!));
    } catch (error) {
      return sendJson(res, 400, { error: (error as Error).message });
    }
  }
  if (pathname === '/api/recurrences/atendimento-labels') {
    if (req.method === 'GET') {
      const promotionName = new URL(req.url ?? '', 'http://localhost').searchParams.get('promotionName')?.trim();
      if (!promotionName) return sendJson(res, 400, { error: 'promotionName obrigatório.' });
      const labels = await listAtendimentoLabels(promotionName);
      return sendJson(res, 200, labels.map(({ atendimentoId, severity, tema }) => ({ atendimentoId, severity, tema })));
    }
    if (req.method !== 'PUT') return sendJson(res, 404, { error: 'Rota de recorrências desconhecida.' });
    const body = (await readJsonBody(req)) as { promotionName?: unknown; atendimentoId?: unknown; severity?: unknown; tema?: unknown };
    const promotionName = String(body.promotionName ?? '').trim();
    const atendimentoId = String(body.atendimentoId ?? '').trim();
    const tema = String(body.tema ?? '').trim().slice(0, 255) || null;
    if (!isSeverity(body.severity)) return sendJson(res, 400, { error: 'Gravidade inválida.' });
    const atendimento = readAtendimentosResult(promotionName)?.atendimentos.find((item) => item.id === atendimentoId);
    if (!atendimento) return sendJson(res, 400, { error: 'Atendimento não está na última consulta dessa promoção.' });
    const saved = await saveAtendimentoLabel(
      { promotionName, atendimentoId, assunto: atendimento.assunto, mensagem: atendimento.mensagem, severity: body.severity, tema },
      getAuthenticatedUserId(req)!,
      [atendimento.participante],
    );
    warmLabelEmbeddings([saved]);
    return sendJson(res, 200, { atendimentoId, severity: body.severity, tema });
  }
  if (pathname === '/api/recurrences/atendimentos-summary') {
    if (req.method !== 'POST') return sendJson(res, 404, { error: 'Rota de recorrências desconhecida.' });
    const promotionName = String(((await readJsonBody(req)) as { promotionName?: unknown }).promotionName ?? '').trim();
    const result = promotionName ? readAtendimentosResult(promotionName) : undefined;
    if (!result) {
      return sendJson(res, 400, { error: 'Nenhuma consulta de atendimentos salva para essa promoção. Clique em "Consultar atendimentos" primeiro.' });
    }
    const disconnected = new AbortController();
    res.on('close', () => disconnected.abort());
    const write = (event: AtendimentosSummaryEvent) => res.write(`${JSON.stringify(event)}\n`);
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
    let summary;
    try {
      summary = await summarizeAtendimentos(
        result.promotionName,
        result.atendimentos,
        (percent) => write({ type: 'progress', percent }),
        disconnected.signal,
      );
    } catch (error) {
      if (disconnected.signal.aborted) return true;
      throw error;
    }
    if (disconnected.signal.aborted) return true;
    rememberSummary(summary);
    write({ type: 'end', success: true, ...summary });
    res.end();
    return true;
  }
  if (!ROUTES.includes(pathname)) return false;
  if (req.method !== 'POST') {
    return sendJson(res, 404, { error: 'Rota de recorrências desconhecida.' });
  }
  if (pathname === '/api/recurrences/whatsapp' || pathname === '/api/recurrences/message') {
    if (!hasRecurrencesScanResult()) {
      return sendJson(res, 400, { error: 'Nenhuma consulta de Recorrências para enviar. Clique em "Consultar promoções" primeiro.' });
    }
    const { summaryPromotions } = (await readJsonBody(req)) as { summaryPromotions?: unknown };
    const names = Array.isArray(summaryPromotions) ? summaryPromotions.map(String) : [];
    const summaryLines = summaryWhatsAppLines(names);
    if (names.length > 0 && summaryLines.length === 0) {
      return sendJson(res, 400, { error: 'Resumo não encontrado no servidor. Gere o resumo dos atendimentos de novo.' });
    }
    const appendix = summaryLines.length > 0 ? ['', ...summaryLines] : [];
    if (pathname === '/api/recurrences/message') {
      return sendJson(res, 200, { text: [...lastRecurrencesMessage(), ...appendix].join('\n') });
    }
    const startedAt = Date.now();
    const error = await sendRecurrencesWhatsApp(undefined, appendix);
    logManual(getAuthenticatedUserId(req)!, 'Envio no WhatsApp', startedAt, error ? { success: false, error } : { success: true }, 'Resultado enviado no WhatsApp.', {
      resumosDeAtendimentos: names.length,
      ...(names.length > 0 && { resumos: names.join(', ') }),
    });
    return error ? sendJson(res, 502, { error }) : sendJson(res, 200, { ok: true });
  }
  const userId = getAuthenticatedUserId(req)!;
  const connection = getPromoMonitorConnection(userId);
  if (!connection) {
    return sendJson(res, 400, { error: 'Monitor de Promoções não conectado. Conecte em Configurações → Conectores → Monitor de Promoções.' });
  }
  if (pathname === '/api/recurrences/refresh') {
    if (!hasRecurrencesSession()) {
      return sendJson(res, 400, { error: 'Sem sessão do Monitor de Promoções. Clique em "Consultar promoções" primeiro.' });
    }
    runRecurrencesRefreshStreaming(res);
    return true;
  }
  const body = (await readJsonBody(req)) as { totpCode?: string; promotionName?: string; panelUrl?: string };
  const totpCode = String(body.totpCode ?? '').trim();
  if (!totpCode && !connection.totpSecret) {
    return sendJson(res, 400, { error: 'Código do autenticador é obrigatório.' });
  }

  const startedAt = Date.now();
  if (pathname === '/api/recurrences/scan') {
    runRecurrencesScanStreaming(res, connection, totpCode || undefined, (event) =>
      logManual(userId, 'Consulta de promoções', startedAt, event, 'Consulta feita.', event.success ? promotionsScanDetails(event.promotions) : undefined),
    );
    return true;
  }

  const promotionName = String(body.promotionName ?? '').trim();
  const panelUrl = String(body.panelUrl ?? '');
  if (!promotionName) {
    return sendJson(res, 400, { error: 'Promoção é obrigatória.' });
  }
  if (!panelUrl.startsWith('https://') || !lastScannedPanelUrls().has(panelUrl)) {
    return sendJson(res, 400, { error: 'Link do painel não veio da última consulta de Recorrências. Clique em "Consultar promoções" e tente de novo.' });
  }
  runAtendimentosScanStreaming(res, connection, totpCode || undefined, { promotionName, panelUrl }, (event) =>
    logManual(userId, `Atendimentos: ${promotionName}`, startedAt, event, 'Atendimentos coletados.', {
      painel: new URL(panelUrl).host,
      ...(event.success && { atendimentos: event.atendimentos.length }),
    }),
  );
  return true;
}
