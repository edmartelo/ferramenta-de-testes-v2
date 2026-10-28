import { test, expect } from '@playwright/test';
import { createLimiter } from '../../src/lib/limiter';

test.describe('createLimiter', () => {
  test('nunca passa do máximo e respeita a ordem de chegada', async () => {
    const limiter = createLimiter(2);
    let running = 0;
    let peak = 0;
    const order: number[] = [];
    await Promise.all(
      [1, 2, 3, 4, 5].map((id) =>
        limiter.run(async () => {
          running += 1;
          peak = Math.max(peak, running);
          order.push(id);
          await new Promise((resolve) => setTimeout(resolve, 10));
          running -= 1;
        }),
      ),
    );
    expect(peak).toBe(2);
    expect(order).toEqual([1, 2, 3, 4, 5]);
  });

  test('erro na tarefa libera a vaga', async () => {
    const limiter = createLimiter(1);
    await expect(limiter.run(() => Promise.reject(new Error('falhou')))).rejects.toThrow('falhou');
    await expect(limiter.run(async () => 'ok')).resolves.toBe('ok');
  });

  test('liberar duas vezes não abre vaga extra', async () => {
    const limiter = createLimiter(1);
    const release = await limiter.acquire();
    release();
    release();
    const first = await limiter.acquire();
    let second = false;
    void limiter.acquire().then(() => (second = true));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(second).toBe(false);
    first();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(second).toBe(true);
  });
});
