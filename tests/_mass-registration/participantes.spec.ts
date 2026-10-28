import { test } from '../../src/fixtures';
import { formatCpf } from '../../src/lib/participant-data';
import { registerFreshParticipant } from '../../src/lib/registration-form';
import { massQuantity, recordCreated } from './massa';

test.describe('Cadastro em massa › participantes', () => {
  for (let n = 1; n <= massQuantity(); n += 1) {
    test(`participante ${n}`, async ({ page, siteUrl }) => {
      test.slow();
      const participant = await registerFreshParticipant(page, siteUrl);
      recordCreated(`CPF ${formatCpf(participant.cpf)} · ${participant.email} · senha ${participant.senha}`);
    });
  }
});
