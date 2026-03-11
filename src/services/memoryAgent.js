import { config } from '../config.js';
import { createStructuredOutput, createTextOutput } from './openaiClient.js';
import {
  loadMemoryStore,
  readMemoryNodeContent,
  resolveLinkedRegistryEntries
} from './memoryStore.js';

const PRIMARY_NODE_LIMIT = 3;
const SECONDARY_NODE_LIMIT = 3;
const MEMORY_FAILURE_MESSAGE = '関連する記憶を確認できませんでした。少し置いてからもう一度聞いてください。';

export const MEMORY_SELECTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['nodes'],
  properties: {
    nodes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['nodeId', 'reason'],
        properties: {
          nodeId: { type: 'string' },
          reason: { type: 'string' }
        }
      }
    }
  }
};

function formatRegistrySummary(registryEntries) {
  if (!Array.isArray(registryEntries) || registryEntries.length === 0) {
    return '- 候補ノードなし';
  }

  return registryEntries
    .map((entry) => {
      const aliases = entry.aliases.length > 0 ? ` / aliases: ${entry.aliases.join(', ')}` : '';
      return `- id: ${entry.id} / name: ${entry.name} / type: ${entry.type} / description: ${entry.description}${aliases}`;
    })
    .join('\n');
}

function formatNodeForPrompt(node) {
  const lines = [
    `id: ${node.entry.id}`,
    `name: ${node.entry.name}`,
    `type: ${node.entry.type}`,
    `description: ${node.entry.description}`,
    `path: ${node.entry.path}`,
    `links: ${node.links.length > 0 ? node.links.join(', ') : '(none)'}`,
    '[body]',
    node.body || '(empty)'
  ];

  return lines.join('\n');
}

function formatSecondaryCandidateSummary(primaryNodes, linkedEntriesByPrimaryId) {
  if (primaryNodes.length === 0) {
    return '- primary ノードなし';
  }

  return primaryNodes
    .map((node, index) => {
      const linkedEntries = linkedEntriesByPrimaryId.get(node.entry.id) || [];
      return [
        `### primary-${index + 1}`,
        formatNodeForPrompt(node),
        '',
        '[linked registry candidates]',
        linkedEntries.length > 0
          ? linkedEntries
            .map((entry) => {
              const aliases = entry.aliases.length > 0 ? ` / aliases: ${entry.aliases.join(', ')}` : '';
              return `- id: ${entry.id} / name: ${entry.name} / type: ${entry.type} / description: ${entry.description}${aliases}`;
            })
            .join('\n')
          : '- 候補なし'
      ].join('\n');
    })
    .join('\n\n');
}

export function buildPrimarySelectionPrompt({
  text,
  dateKey,
  localTime,
  timeZone,
  conversationText,
  indexMarkdown,
  registryEntries
}) {
  return [
    'あなたは長期記憶ストアの探索計画役です。',
    `現在のローカル日付: ${dateKey}`,
    `現在のローカル時刻: ${localTime}`,
    `タイムゾーン: ${timeZone}`,
    '',
    '目的:',
    '- ユーザー質問に答えるため、まず読むべき primary ノードだけを最大 3 件選ぶ',
    '- まだ本文は読んでいない段階なので、index と registry から必要最小限の候補に絞る',
    '',
    'ルール:',
    '- JSON オブジェクトのみを返す',
    '- nodes は関連度が高い順に並べる',
    '- nodeId は registry に存在するものだけを使う',
    '- 最大 3 件までに絞る。不要なら 0 件でもよい',
    '- reason は短い日本語 1 文で書く',
    '- 推測で存在しない情報を補わない',
    '- 予定更新、SOUL/USER 編集、外部操作をしたふりはしない',
    '',
    '当日会話履歴:',
    conversationText,
    '',
    '[memory/index.md]',
    String(indexMarkdown || '').trim() || '(empty)',
    '',
    '[node registry summary]',
    formatRegistrySummary(registryEntries),
    '',
    '最新のユーザー質問:',
    text
  ].join('\n');
}

export function buildSecondarySelectionPrompt({
  text,
  dateKey,
  localTime,
  timeZone,
  conversationText,
  primaryNodes,
  linkedEntriesByPrimaryId
}) {
  return [
    'あなたは長期記憶ストアの二次探索役です。',
    `現在のローカル日付: ${dateKey}`,
    `現在のローカル時刻: ${localTime}`,
    `タイムゾーン: ${timeZone}`,
    '',
    '目的:',
    '- すでに読んだ primary ノード本文を踏まえて、追加で読むべき secondary ノードを最大 3 件選ぶ',
    '',
    'ルール:',
    '- JSON オブジェクトのみを返す',
    '- secondary 候補は primary ノード frontmatter の links に含まれる node だけに限定する',
    '- nodes は全 primary 横断で最大 3 件までに絞る',
    '- nodeId は linked registry candidates に存在するものだけを使う',
    '- reason は短い日本語 1 文で書く',
    '- primary 本文に根拠がなければ無理に選ばない',
    '- 1-hop で止める。さらに先のリンクは辿らない',
    '',
    '当日会話履歴:',
    conversationText,
    '',
    '[primary nodes and linked candidates]',
    formatSecondaryCandidateSummary(primaryNodes, linkedEntriesByPrimaryId),
    '',
    '最新のユーザー質問:',
    text
  ].join('\n');
}

export function buildMemoryReplyPrompt({
  text,
  dateKey,
  localTime,
  timeZone,
  conversationText,
  primaryNodes,
  secondaryNodes
}) {
  const allNodes = [...primaryNodes, ...secondaryNodes];
  const memoryContext = allNodes.length > 0
    ? allNodes
      .map((node, index) => [`### node-${index + 1}`, formatNodeForPrompt(node)].join('\n'))
      .join('\n\n')
    : '- relevant memory nodes: none';

  return [
    'あなたは長期記憶を参照してユーザーに返答する秘書です。',
    `現在のローカル日付: ${dateKey}`,
    `現在のローカル時刻: ${localTime}`,
    `タイムゾーン: ${timeZone}`,
    '',
    '役割:',
    '- 読み取れた記憶ノードだけを根拠に、自然な日本語の返答本文を 1 本だけ返す',
    '',
    '厳守ルール:',
    '- 読めた事実だけを使う',
    '- 根拠が足りないことは断定しない',
    '- 情報が見つからない場合は、その旨を明確に伝える',
    '- ありもしない事実を補完しない',
    '- `memory` 以外の操作をしたふりをしない',
    '- 通常は参照元ノード名をわざわざ列挙しない',
    '- 回答は自然な日本語の本文だけにする',
    '',
    '当日会話履歴:',
    conversationText,
    '',
    '[relevant memory nodes]',
    memoryContext,
    '',
    '最新のユーザー質問:',
    text
  ].join('\n');
}

export function normalizeMemorySelectionIds(rawNodes, allowedIds, limit) {
  const normalized = [];
  const seenIds = new Set();
  const allowed = new Set(Array.isArray(allowedIds) ? allowedIds : []);

  for (const node of Array.isArray(rawNodes) ? rawNodes : []) {
    const nodeId = String(node?.nodeId || '').trim();
    const reason = String(node?.reason || '').trim();
    if (!nodeId || !allowed.has(nodeId) || seenIds.has(nodeId)) {
      continue;
    }

    seenIds.add(nodeId);
    normalized.push({ nodeId, reason });
    if (normalized.length >= limit) {
      break;
    }
  }

  return normalized;
}

function toMemoryFilePath(relativePath) {
  const normalizedFolder = String(config.googleDrive.memoryFolderName || 'memory').trim() || 'memory';
  const normalizedPath = String(relativePath || '').trim().replace(/^\/+/, '');
  return normalizedPath ? `${normalizedFolder}/${normalizedPath}` : normalizedFolder;
}

async function selectPrimaryNodes({
  text,
  dateContext,
  conversationContext,
  indexMarkdown,
  registryEntries,
  createStructuredOutputFn
}) {
  const raw = await createStructuredOutputFn({
    model: config.openai.taskModel,
    schemaName: 'memory_primary_selection',
    schema: MEMORY_SELECTION_SCHEMA,
    systemPrompt: '必ずスキーマに一致する正しいJSONオブジェクトだけを返してください。',
    userPrompt: buildPrimarySelectionPrompt({
      text,
      ...dateContext,
      conversationText: conversationContext.text,
      indexMarkdown,
      registryEntries
    })
  });

  return normalizeMemorySelectionIds(
    raw.nodes,
    registryEntries.map((entry) => entry.id),
    PRIMARY_NODE_LIMIT
  );
}

async function selectSecondaryNodes({
  text,
  dateContext,
  conversationContext,
  primaryNodes,
  linkedEntriesByPrimaryId,
  createStructuredOutputFn
}) {
  const allowedIds = Array.from(new Set(
    primaryNodes.flatMap((node) => (linkedEntriesByPrimaryId.get(node.entry.id) || []).map((entry) => entry.id))
  ));

  if (allowedIds.length === 0) {
    return [];
  }

  const raw = await createStructuredOutputFn({
    model: config.openai.taskModel,
    schemaName: 'memory_secondary_selection',
    schema: MEMORY_SELECTION_SCHEMA,
    systemPrompt: '必ずスキーマに一致する正しいJSONオブジェクトだけを返してください。',
    userPrompt: buildSecondarySelectionPrompt({
      text,
      ...dateContext,
      conversationText: conversationContext.text,
      primaryNodes,
      linkedEntriesByPrimaryId
    })
  });

  return normalizeMemorySelectionIds(raw.nodes, allowedIds, SECONDARY_NODE_LIMIT);
}

async function generateMemoryReply({
  text,
  dateContext,
  conversationContext,
  primaryNodes,
  secondaryNodes,
  createTextOutputFn
}) {
  return createTextOutputFn({
    model: config.openai.taskModel,
    systemPrompt: '完成済みの日本語メッセージ本文だけを返してください。前置きや説明は不要です。',
    userPrompt: buildMemoryReplyPrompt({
      text,
      ...dateContext,
      conversationText: conversationContext.text,
      primaryNodes,
      secondaryNodes
    })
  });
}

function normalizeMemoryReply(value) {
  const normalized = String(value || '')
    .trim()
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .slice(0, 5000);

  return normalized || '関連する記憶は見つかりませんでした。';
}

export async function answerFromMemory(
  { text, conversationContext, dateContext },
  deps = {}
) {
  const loadMemoryStoreFn = deps.loadMemoryStore || loadMemoryStore;
  const readMemoryNodeContentFn = deps.readMemoryNodeContent || readMemoryNodeContent;
  const createStructuredOutputFn = deps.createStructuredOutput || createStructuredOutput;
  const createTextOutputFn = deps.createTextOutput || createTextOutput;
  const readFiles = [
    toMemoryFilePath('index.md'),
    toMemoryFilePath('node-registry.yaml')
  ];
  const logContext = {
    action: 'memory',
    query: String(text || '').trim(),
    dateKey: String(dateContext?.dateKey || '').trim(),
    localTime: String(dateContext?.localTime || '').trim(),
    timeZone: String(dateContext?.timeZone || '').trim()
  };

  try {
    const memoryStore = await loadMemoryStoreFn();
    const primarySelections = await selectPrimaryNodes({
      text,
      dateContext,
      conversationContext,
      indexMarkdown: memoryStore.indexMarkdown,
      registryEntries: memoryStore.registryEntries,
      createStructuredOutputFn
    });

    const primaryNodes = await Promise.all(
      primarySelections.map(async (selection) => {
        const entry = memoryStore.registryById.get(selection.nodeId);
        readFiles.push(toMemoryFilePath(entry?.path));
        return readMemoryNodeContentFn(entry);
      })
    );

    const linkedEntriesByPrimaryId = new Map(
      primaryNodes.map((node) => [
        node.entry.id,
        resolveLinkedRegistryEntries(node, memoryStore.registryById, memoryStore.registryByPath)
      ])
    );

    const secondarySelections = await selectSecondaryNodes({
      text,
      dateContext,
      conversationContext,
      primaryNodes,
      linkedEntriesByPrimaryId,
      createStructuredOutputFn
    });

    const secondaryNodes = await Promise.all(
      secondarySelections.map(async (selection) => {
        const entry = memoryStore.registryById.get(selection.nodeId);
        readFiles.push(toMemoryFilePath(entry?.path));
        return readMemoryNodeContentFn(entry);
      })
    );

    const reply = await generateMemoryReply({
      text,
      dateContext,
      conversationContext,
      primaryNodes,
      secondaryNodes,
      createTextOutputFn
    });

    const normalizedReply = normalizeMemoryReply(reply);
    console.log('[memory-agent] completed', {
      ...logContext,
      primaryNodeIds: primaryNodes.map((node) => node.entry.id),
      secondaryNodeIds: secondaryNodes.map((node) => node.entry.id),
      readFiles: Array.from(new Set(readFiles))
    });
    return normalizedReply;
  } catch (error) {
    console.error('[memory-agent] failed', {
      ...logContext,
      readFiles: Array.from(new Set(readFiles)),
      error: String(error?.message || error)
    });
    return MEMORY_FAILURE_MESSAGE;
  }
}

export const memoryAgentInternals = {
  PRIMARY_NODE_LIMIT,
  SECONDARY_NODE_LIMIT,
  MEMORY_FAILURE_MESSAGE,
  formatRegistrySummary,
  formatSecondaryCandidateSummary,
  normalizeMemoryReply,
  selectPrimaryNodes,
  selectSecondaryNodes,
  generateMemoryReply
};
