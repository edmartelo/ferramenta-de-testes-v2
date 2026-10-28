/** Fila FIFO com no máximo `max` tarefas ao mesmo tempo. */
export function createLimiter(max: number) {
  let running = 0;
  const waiting: (() => void)[] = [];

  function release(): void {
    const next = waiting.shift();
    if (next) next();
    else running -= 1;
  }

  function releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
    };
  }

  /** Vaga agora ou `undefined`, sem entrar na fila. A função devolvida libera a vaga e só tem efeito na primeira chamada. */
  function tryAcquire(): (() => void) | undefined {
    if (running >= max) return undefined;
    running += 1;
    return releaser();
  }

  /** Resolve quando há vaga, na ordem de chegada. */
  async function acquire(): Promise<() => void> {
    const now = tryAcquire();
    if (now) return now;
    await new Promise<void>((resolve) => waiting.push(resolve));
    return releaser();
  }

  async function run<T>(task: () => Promise<T>): Promise<T> {
    const done = await acquire();
    try {
      return await task();
    } finally {
      done();
    }
  }

  return { acquire, tryAcquire, run };
}
