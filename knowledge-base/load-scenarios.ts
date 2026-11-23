/** Cenários de carga do JMeter: um `.jmx` em `performance/`, igual para todas as promoções. */
export interface LoadScenario {
  id: string;
  label: string;
  description: string;
  /** Nome do arquivo em `performance/`. */
  plan: string;
  /** Cria participante, cupom ou outro dado no site. */
  createsData: boolean;
}

export const LOAD_SCENARIOS: readonly LoadScenario[] = [
  {
    id: 'paginas-publicas',
    label: 'Páginas públicas',
    description: 'Home com JS e CSS, e as consultas públicas da API: regulamento, ganhadores e dúvidas.',
    plan: 'paginas-publicas.jmx',
    createsData: false,
  },
];

export function findLoadScenario(id: unknown): LoadScenario | undefined {
  return LOAD_SCENARIOS.find((scenario) => scenario.id === id);
}
