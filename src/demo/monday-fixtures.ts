import type { MondayBoardDetail, MondayColumn, MondayItem, MondayItemColumnValue, MondaySubitem, MondayUpdate, MondayUser, MondayWorkspaceBoards } from '../api';

/** Monday fictício da demo: quadros, itens, comentários e subitens só na memória da aba; nada sai do navegador. */

const USERS: MondayUser[] = [
  { id: '9001', name: 'Ana Silva (exemplo)', photo_thumb_small: null },
  { id: '9002', name: 'João Souza (exemplo)', photo_thumb_small: null },
  { id: '9003', name: 'Marina Costa (exemplo)', photo_thumb_small: null },
];

const STATUS_OPTIONS = [
  { id: '0', label: 'Em teste', color: '#fdab3d' },
  { id: '1', label: 'Aprovado', color: '#00c875' },
  { id: '2', label: 'Com erro', color: '#e2445c' },
  { id: '3', label: 'Aguardando agência', color: '#579bfc' },
];

const ENV_OPTIONS = [
  { id: '1', label: 'Dev' },
  { id: '2', label: 'Homolog' },
  { id: '3', label: 'Produção' },
];

const PROMO_COLUMNS: MondayColumn[] = [
  { id: 'name', title: 'Nome', type: 'name', editable: false },
  { id: 'status', title: 'Status', type: 'status', editable: true, options: STATUS_OPTIONS },
  { id: 'people', title: 'Responsável', type: 'people', editable: true },
  { id: 'ambiente', title: 'Ambiente', type: 'dropdown', editable: true, options: ENV_OPTIONS },
  { id: 'prazo', title: 'Prazo', type: 'date', editable: true },
  { id: 'agencia', title: 'Agência', type: 'text', editable: true },
  { id: 'revisado', title: 'Revisado', type: 'checkbox', editable: true },
  { id: 'site', title: 'Site', type: 'link', editable: true },
  { id: 'subitens', title: 'Subitens', type: 'subtasks', editable: false },
];

const BUG_COLUMNS: MondayColumn[] = [
  { id: 'name', title: 'Nome', type: 'name', editable: false },
  { id: 'status', title: 'Status', type: 'status', editable: true, options: STATUS_OPTIONS },
  { id: 'people', title: 'Responsável', type: 'people', editable: true },
  { id: 'prazo', title: 'Prazo', type: 'date', editable: true },
  { id: 'detalhes', title: 'Detalhes', type: 'long_text', editable: true },
  { id: 'subitens', title: 'Subitens', type: 'subtasks', editable: false },
];

const SUBITEM_COLUMNS: MondayColumn[] = [
  { id: 'name', title: 'Nome', type: 'name', editable: false },
  { id: 'status', title: 'Status', type: 'status', editable: true, options: STATUS_OPTIONS },
  { id: 'people', title: 'Responsável', type: 'people', editable: true },
];

interface DemoBoard {
  id: string;
  name: string;
  columns: MondayColumn[];
  groups: { id: string; title: string; color?: string }[];
  items: (MondayItem & { groupId: string; parentId?: string })[];
}

const SUBITEMS_BOARD_ID = '7700';

function columnValue(column: MondayColumn, raw: unknown): MondayItemColumnValue {
  const base = { columnId: column.id, value: raw };
  if (raw === null || raw === undefined || raw === '') return { ...base, value: raw ?? null, text: '' };
  switch (column.type) {
    case 'checkbox':
      return { ...base, text: raw === true ? 'v' : '' };
    case 'dropdown':
      return { ...base, text: (raw as string[]).join(', ') };
    case 'people':
      return { ...base, text: (raw as string[]).map((id) => USERS.find((user) => user.id === String(id))?.name).filter(Boolean).join(', ') };
    case 'date':
      return { ...base, text: (raw as { date: string }).date };
    case 'link': {
      const link = raw as { url: string; text?: string };
      return { ...base, text: link.text || link.url };
    }
    default:
      return { ...base, text: String(raw) };
  }
}

/** Cópia simples: os valores do formulário chegam como objetos reativos do Vue, que o `structuredClone` recusa. */
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

let nextId = 8000;

function day(offsetDays: number): { date: string } {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return { date: date.toISOString().slice(0, 10) };
}

function promoItem(groupId: string, name: string, status: string, people: string[], ambiente: string[], prazo: number, agencia: string, revisado: boolean) {
  const values = { status, people, ambiente, prazo: day(prazo), agencia, revisado, site: { url: `https://${name.toLowerCase().normalize('NFD').replace(/[^a-z]+/g, '-')}.promo-exemplo.com.br`, text: 'Abrir site' } };
  return { id: String(nextId++), name, groupId, columnValues: PROMO_COLUMNS.filter((c) => c.type !== 'name' && c.type !== 'subtasks').map((c) => columnValue(c, values[c.id as keyof typeof values])) };
}

function bugItem(groupId: string, name: string, status: string, people: string[], prazo: number, detalhes: string) {
  const values = { status, people, prazo: day(prazo), detalhes };
  return { id: String(nextId++), name, groupId, columnValues: BUG_COLUMNS.filter((c) => c.type !== 'name' && c.type !== 'subtasks').map((c) => columnValue(c, values[c.id as keyof typeof values])) };
}

const boards: DemoBoard[] = [
  {
    id: '7101',
    name: 'Promoções em teste',
    columns: PROMO_COLUMNS,
    groups: [
      { id: 'andamento', title: 'Em andamento', color: '#fdab3d' },
      { id: 'concluidas', title: 'Concluídas', color: '#00c875' },
    ],
    items: [
      promoItem('andamento', 'Promo Verão Premiado', 'Em teste', ['9001'], ['Homolog'], 3, 'Agência Aurora', false),
      promoItem('andamento', 'Junte e Ganhe Demo', 'Com erro', ['9002'], ['Dev', 'Homolog'], 1, 'Horizonte Digital', false),
      promoItem('andamento', 'Raspou, Ganhou!', 'Aguardando agência', ['9003', '9001'], ['Homolog'], 5, 'Pixel & Cia', true),
      promoItem('concluidas', 'Show de Prêmios Exemplo', 'Aprovado', ['9002'], ['Produção'], -4, 'Agência Aurora', true),
    ],
  },
  {
    id: '7102',
    name: 'Bugs e melhorias',
    columns: BUG_COLUMNS,
    groups: [
      { id: 'abertos', title: 'Abertos', color: '#e2445c' },
      { id: 'resolvidos', title: 'Resolvidos', color: '#00c875' },
    ],
    items: [
      bugItem('abertos', 'Cadastro aceita CPF com dígito errado', 'Com erro', ['9002'], 2, 'Formulário de cadastro em Homolog aceita CPF inválido quando o campo perde o foco antes da máscara completar.'),
      bugItem('abertos', 'Modal de cupom sem mensagem de valor mínimo', 'Aguardando agência', ['9003'], 4, 'Ao enviar cupom abaixo do valor mínimo, o modal fecha sem mostrar o erro.'),
      bugItem('resolvidos', 'Link do regulamento quebrado no rodapé', 'Aprovado', ['9001'], -2, 'Corrigido pela agência e validado em Produção.'),
    ],
  },
  { id: SUBITEMS_BOARD_ID, name: 'Subitens', columns: SUBITEM_COLUMNS, groups: [{ id: 'subitens', title: 'Subitens' }], items: [] },
];

const updates = new Map<string, MondayUpdate[]>();

function addUpdate(itemId: string, body: string, author = 'Você (demonstração)'): string {
  const id = String(nextId++);
  const list = updates.get(itemId) ?? [];
  list.unshift({ id, text_body: body, created_at: new Date().toISOString(), creator: { name: author } });
  updates.set(itemId, list);
  return id;
}

function subitem(parentId: string, name: string, status: string, people: string[]) {
  const values = { status, people };
  boards[2]!.items.push({
    id: String(nextId++),
    name,
    groupId: 'subitens',
    parentId,
    columnValues: SUBITEM_COLUMNS.filter((c) => c.type !== 'name').map((c) => columnValue(c, values[c.id as keyof typeof values])),
  });
}

const verao = boards[0]!.items[0]!.id;
const junte = boards[0]!.items[1]!.id;
subitem(verao, 'Cadastro de participante', 'Aprovado', ['9001']);
subitem(verao, 'Cadastro de cupom', 'Em teste', ['9001']);
subitem(junte, 'Meus dados', 'Com erro', ['9002']);
addUpdate(junte, 'Rodada em Homolog: 2 falhas no cadastro de cupom. Mandei os prints para a agência.', 'João Souza (exemplo)');
addUpdate(verao, 'Testes automáticos ok em Homolog; falta a conferência manual.', 'Ana Silva (exemplo)');

function board(boardId: string): DemoBoard {
  const found = boards.find((b) => b.id === boardId);
  if (!found) throw new Error('Quadro não encontrado.');
  return found;
}

function findItem(itemId: string): { board: DemoBoard; item: DemoBoard['items'][number] } {
  for (const candidate of boards) {
    const item = candidate.items.find((i) => i.id === itemId);
    if (item) return { board: candidate, item };
  }
  throw new Error('Item não encontrado.');
}

function setValues(target: DemoBoard, item: MondayItem, values: Record<string, unknown> = {}): void {
  for (const [columnId, raw] of Object.entries(clone(values))) {
    const column = target.columns.find((c) => c.id === columnId);
    if (!column) continue;
    const next = columnValue(column, raw);
    const index = item.columnValues.findIndex((cv) => cv.columnId === columnId);
    if (index >= 0) item.columnValues[index] = next;
    else item.columnValues.push(next);
  }
}


export const demoMonday = {
  boards: (): MondayWorkspaceBoards[] => [
    { workspace: { id: '77', name: 'Equipe QA (fictícia)' }, boards: boards.filter((b) => b.id !== SUBITEMS_BOARD_ID).map(({ id, name }) => ({ id, name })) },
  ],
  boardDetail: (boardId: string): MondayBoardDetail => clone({ columns: board(boardId).columns, groups: board(boardId).groups }),
  createGroup: (boardId: string, name: string) => {
    const group = { id: `grupo-${nextId++}`, title: name, color: '#a25ddc' };
    board(boardId).groups.push(group);
    return clone(group);
  },
  items: (boardId: string, groupId: string) => ({ cursor: null, items: clone(board(boardId).items.filter((i) => i.groupId === groupId).map(({ id, name, columnValues }) => ({ id, name, columnValues }))) }),
  item: (itemId: string): MondayItem => {
    const { item } = findItem(itemId);
    return clone({ id: item.id, name: item.name, columnValues: item.columnValues });
  },
  createItem: (boardId: string, data: { name: string; groupId?: string; columnValues?: Record<string, unknown>; updateText?: string }) => {
    const target = board(boardId);
    const item = { id: String(nextId++), name: data.name, groupId: data.groupId ?? target.groups[0]!.id, columnValues: [] as MondayItemColumnValue[] };
    setValues(target, item, data.columnValues);
    target.items.push(item);
    if (data.updateText) addUpdate(item.id, data.updateText);
    return { id: item.id, name: item.name };
  },
  updateItem: (itemId: string, data: { name?: string; columnValues?: Record<string, unknown> }) => {
    const { board: target, item } = findItem(itemId);
    if (data.name) item.name = data.name;
    setValues(target, item, data.columnValues);
    return { id: item.id, name: item.name };
  },
  deleteItem: (itemId: string) => {
    const { board: target, item } = findItem(itemId);
    target.items.splice(target.items.indexOf(item), 1);
    boards[2]!.items = boards[2]!.items.filter((sub) => sub.parentId !== itemId);
    updates.delete(itemId);
    return { ok: true as const };
  },
  users: (): MondayUser[] => clone(USERS),
  itemUpdates: (itemId: string): MondayUpdate[] => clone(updates.get(itemId) ?? []),
  postUpdate: (itemId: string, body: string) => ({ id: addUpdate(itemId, body) }),
  postChecklistUpdate: (itemId: string, data: { title: string; tasks: string[] }) => ({
    id: addUpdate(itemId, [data.title, ...data.tasks.map((task) => `☐ ${task}`)].join('\n')),
    url: null,
  }),
  subitems: (itemId: string): MondaySubitem[] =>
    boards[2]!.items.filter((sub) => sub.parentId === itemId).map(({ id, name }) => ({ id, name, boardId: SUBITEMS_BOARD_ID })),
  createSubitem: (itemId: string, name: string) => {
    findItem(itemId);
    boards[2]!.items.push({ id: String(nextId++), name, groupId: 'subitens', parentId: itemId, columnValues: [] });
    return { ok: true as const };
  },
};
