import { join } from 'node:path';
import { readJsonFile, writeJsonFile } from '../src/lib/json-file.ts';
import { PROJECT_ROOT } from '../src/lib/paths.ts';
import { decryptSecret, encryptSecret, isEncryptedSecret } from '../src/lib/secret-box.ts';

const CONNECTORS_FILE_PATH = join(PROJECT_ROOT, '.connectors.json');

interface MondayConnection {
  accessToken: string;
  accountName?: string;
  connectedAt: string;
}

export interface PromoMonitorConnection {
  email: string;
  password: string;
  totpSecret?: string;
  /** Hostname → chave do Authenticator, pros painéis com 2FA próprio (não o do Monitor). */
  panelTotpSecrets?: Record<string, string>;
  connectedAt: string;
}

interface SlackConnection {
  accessToken: string;
  teamName?: string;
  connectedAt: string;
}

interface UserConnectors {
  monday?: MondayConnection;
  promoMonitor?: PromoMonitorConnection;
  slack?: SlackConnection;
}

/** Senhas, tokens e chaves do autenticador ficam cifrados no arquivo; em memória, decifrados. */
function mapSecrets(connectors: UserConnectors, map: (value: string) => string): UserConnectors {
  const { monday, promoMonitor, slack } = connectors;
  return {
    ...connectors,
    ...(monday && { monday: { ...monday, accessToken: map(monday.accessToken) } }),
    ...(slack && { slack: { ...slack, accessToken: map(slack.accessToken) } }),
    ...(promoMonitor && {
      promoMonitor: {
        ...promoMonitor,
        password: map(promoMonitor.password),
        ...(promoMonitor.totpSecret !== undefined && { totpSecret: map(promoMonitor.totpSecret) }),
        ...(promoMonitor.panelTotpSecrets && {
          panelTotpSecrets: Object.fromEntries(Object.entries(promoMonitor.panelTotpSecrets).map(([host, secret]) => [host, map(secret)])),
        }),
      },
    }),
  };
}

const sealSecret = (value: string) => (value && !isEncryptedSecret(value) ? encryptSecret(value) : value);

function readConnectorsFile(): Record<string, UserConnectors> {
  return readJsonFile<Record<string, UserConnectors>>(CONNECTORS_FILE_PATH, {});
}

function writeConnectorsFile(all: Record<string, UserConnectors>): void {
  writeJsonFile(CONNECTORS_FILE_PATH, Object.fromEntries(Object.entries(all).map(([userId, connectors]) => [userId, mapSecrets(connectors, sealSecret)])));
}

export function getUserConnectors(userId: string): UserConnectors {
  return mapSecrets(readConnectorsFile()[userId] ?? {}, decryptSecret);
}

/** `undefined` no patch desconecta aquele conector; o resto do arquivo segue cifrado como está. */
export function updateUserConnectors(userId: string, patch: UserConnectors): void {
  const all = readConnectorsFile();
  if (!all[userId] && Object.values(patch).every((value) => value === undefined)) return;
  all[userId] = { ...all[userId], ...patch };
  writeConnectorsFile(all);
}

/** Arquivo gravado antes da cifra: regrava cifrado na subida do servidor. */
export function encryptStoredConnectors(): void {
  const all = readConnectorsFile();
  const sealed = Object.values(all).map((connectors) => mapSecrets(connectors, sealSecret));
  if (JSON.stringify(sealed) !== JSON.stringify(Object.values(all))) writeConnectorsFile(all);
}

export function getPromoMonitorConnection(userId: string): PromoMonitorConnection | undefined {
  return getUserConnectors(userId).promoMonitor;
}
