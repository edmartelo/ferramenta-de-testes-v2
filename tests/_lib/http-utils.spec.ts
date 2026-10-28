import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { test, expect } from '@playwright/test';
import { BadRequestError, isCrossOriginWrite, readJsonBody } from '../../server/http-utils';

function fakeRequest(method: string, headers: Record<string, string>, body = ''): IncomingMessage {
  return Object.assign(Readable.from(body ? [Buffer.from(body)] : []), { method, headers }) as unknown as IncomingMessage;
}

test.describe('isCrossOriginWrite', () => {
  test('só barra escrita com Origin de outro site', () => {
    const host = { host: 'localhost:15173' };
    expect(isCrossOriginWrite(fakeRequest('GET', { ...host, origin: 'http://evil.example' }))).toBe(false);
    expect(isCrossOriginWrite(fakeRequest('POST', host))).toBe(false);
    expect(isCrossOriginWrite(fakeRequest('POST', { ...host, origin: 'http://localhost:15173' }))).toBe(false);
    expect(isCrossOriginWrite(fakeRequest('POST', { ...host, origin: 'http://localhost:3000' }))).toBe(true);
    expect(isCrossOriginWrite(fakeRequest('DELETE', { ...host, origin: 'http://evil.example' }))).toBe(true);
  });
});

test.describe('readJsonBody', () => {
  test('lê objeto JSON e trata corpo vazio como objeto vazio', async () => {
    expect(await readJsonBody(fakeRequest('POST', {}, '{"a":1}'))).toEqual({ a: 1 });
    expect(await readJsonBody(fakeRequest('POST', {}))).toEqual({});
  });

  test('recusa JSON inválido, array e corpo acima do limite', async () => {
    await expect(readJsonBody(fakeRequest('POST', {}, '{a'))).rejects.toBeInstanceOf(BadRequestError);
    await expect(readJsonBody(fakeRequest('POST', {}, '[1]'))).rejects.toBeInstanceOf(BadRequestError);
    await expect(readJsonBody(fakeRequest('POST', {}, `{"a":"${'x'.repeat(100)}"}`), 50)).rejects.toBeInstanceOf(BadRequestError);
  });
});
