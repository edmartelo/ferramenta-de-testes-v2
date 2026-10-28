import { test, expect } from '@playwright/test';
import { requireLoopbackUrl } from '../../src/lib/loopback-url';

test.describe('requireLoopbackUrl', () => {
  test('aceita só endereços desta máquina', () => {
    for (const url of ['http://127.0.0.1:11434', 'http://localhost:11434', 'http://[::1]:11434']) {
      expect(requireLoopbackUrl(url, 'OLLAMA_URL')).toBe(url);
    }
  });

  test('recusa host externo, inclusive disfarçado', () => {
    for (const url of ['https://api.exemplo.com', 'http://127.0.0.1.exemplo.com', 'http://localhost@exemplo.com', 'http://10.0.0.5:11434']) {
      expect(() => requireLoopbackUrl(url, 'OLLAMA_URL')).toThrow(/OLLAMA_URL/);
    }
  });

  test('recusa valor que não é URL', () => {
    expect(() => requireLoopbackUrl('127.0.0.1:11434', 'OLLAMA_URL')).toThrow(/OLLAMA_URL/);
  });
});
