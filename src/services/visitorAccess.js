import { config } from '../config.js';
import {
  readVisitorRegistrationState,
  writeTextFileInDriveSubfolder,
  writeVisitorRegistrationState
} from './googleDriveState.js';
import { getUserProfile, pushMessage } from './lineClient.js';
import { loadMemoryStore, normalizeMemoryAccessScopes, readMemoryNodeContent, stringifyMemoryMarkdown } from './memoryStore.js';
import { createStructuredOutput } from './openaiClient.js';

export const REGISTER_VISITOR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'outcome',
    'pendingVisitorUserId',
    'personId',
    'personName',
    'updateRole',
    'role',
    'updateRelationshipToOwner',
    'relationshipToOwner',
    'updateScopePolicy',
    'scopePolicy',
    'message'
  ],
  properties: {
    outcome: {
      type: 'string',
      enum: ['updated', 'clarify']
    },
    pendingVisitorUserId: { type: 'string' },
    personId: { type: 'string' },
    personName: { type: 'string' },
    updateRole: { type: 'boolean' },
    role: { type: 'string' },
    updateRelationshipToOwner: { type: 'boolean' },
    relationshipToOwner: { type: 'string' },
    updateScopePolicy: { type: 'boolean' },
    scopePolicy: {
      type: 'object',
      additionalProperties: false,
      required: ['allowedScopes'],
      properties: {
        allowedScopes: {
          type: 'array',
          items: { type: 'string' }
        }
      }
    },
    message: { type: 'string' }
  }
};

export const VISITOR_PERMISSION_REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['decision', 'message'],
  properties: {
    decision: {
      type: 'string',
      enum: ['allow', 'redact', 'deny']
    },
    message: { type: 'string' }
  }
};

export const UNREGISTERED_VISITOR_MESSAGE =
  'このアカウントでは、まだ案内可能な情報が設定されていません。必要ならオーナーに登録を依頼してください。';
export const AMBIGUOUS_VISITOR_MESSAGE =
  'このアカウントでは、あなた向けの案内設定をまだ特定できていません。オーナーに確認してください。';
export const OWNER_INFO_DENIED_MESSAGE =
  'このアカウントのオーナーに関する情報は案内できません。';

function normalizeString(value, maxLength = 500) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

export function normalizeLineUserIds(frontmatter = {}) {
  const identities = frontmatter.identities && typeof frontmatter.identities === 'object' && !Array.isArray(frontmatter.identities)
    ? frontmatter.identities
    : {};
  const rawValues = Array.isArray(identities.lineUserIds)
    ? identities.lineUserIds
    : typeof identities.lineUserIds === 'string'
      ? [identities.lineUserIds]
      : typeof identities.lineUserId === 'string'
        ? [identities.lineUserId]
        : [];

  return Array.from(new Set(rawValues.map((value) => normalizeString(value, 120)).filter(Boolean)));
}

export function normalizeScopePolicy(rawScopePolicy) {
  const rawAllowedScopes = Array.isArray(rawScopePolicy?.allowedScopes)
    ? rawScopePolicy.allowedScopes
    : Array.isArray(rawScopePolicy)
      ? rawScopePolicy
      : [];

  return {
    allowedScopes: Array.from(new Set(
      rawAllowedScopes.map((scope) => normalizeString(scope, 120)).filter(Boolean)
    )).slice(0, 50)
  };
}

function normalizePendingVisitors(source) {
  return source && typeof source === 'object' && !Array.isArray(source) ? source : {};
}

function listPendingVisitors(state) {
  return Object.values(normalizePendingVisitors(state?.pendingVisitors))
    .filter((record) => record && record.status === 'pending' && record.lineUserId)
    .sort((left, right) => String(right.lastSeenAt || '').localeCompare(String(left.lastSeenAt || '')));
}

async function loadPeopleNodes({ loadMemoryStoreFn, readMemoryNodeContentFn }) {
  const memoryStore = await loadMemoryStoreFn();
  const personEntries = memoryStore.registryEntries.filter((entry) => {
    return entry.type === 'person' && entry.path.startsWith('people/');
  });
  const personNodes = await Promise.all(personEntries.map((entry) => readMemoryNodeContentFn(entry)));

  return {
    memoryStore,
    personEntries,
    personNodes
  };
}

function buildPersonSummary(node) {
  return {
    personId: node.entry.id,
    name: node.entry.name,
    description: normalizeString(node.frontmatter.description || node.entry.description || '', 240),
    role: normalizeString(node.frontmatter.role || '', 120),
    relationshipToOwner: normalizeString(node.frontmatter.relationshipToOwner || '', 120),
    scopePolicy: normalizeScopePolicy(node.frontmatter.scopePolicy)
  };
}

export async function resolveVisitorIdentity({ lineUserId }, deps = {}) {
  const normalizedLineUserId = normalizeString(lineUserId, 120);
  if (!normalizedLineUserId) {
    return { status: 'unregistered', lineUserId: '', personId: '', personSummary: null, scopePolicy: { allowedScopes: [] } };
  }

  const loadMemoryStoreFn = deps.loadMemoryStore || loadMemoryStore;
  const readMemoryNodeContentFn = deps.readMemoryNodeContent || readMemoryNodeContent;
  const { personNodes } = await loadPeopleNodes({ loadMemoryStoreFn, readMemoryNodeContentFn });

  const matches = personNodes.filter((node) => normalizeLineUserIds(node.frontmatter).includes(normalizedLineUserId));
  if (matches.length === 0) {
    return {
      status: 'unregistered',
      lineUserId: normalizedLineUserId,
      personId: '',
      personSummary: null,
      scopePolicy: { allowedScopes: [] }
    };
  }

  if (matches.length > 1) {
    return {
      status: 'ambiguous',
      lineUserId: normalizedLineUserId,
      personId: '',
      personSummary: null,
      scopePolicy: { allowedScopes: [] }
    };
  }

  const personSummary = buildPersonSummary(matches[0]);
  return {
    status: 'registered',
    lineUserId: normalizedLineUserId,
    personId: personSummary.personId,
    personSummary,
    scopePolicy: personSummary.scopePolicy
  };
}

function formatPendingVisitorSummary(record) {
  const parts = [
    `userId: ${record.lineUserId}`
  ];
  if (record.displayName) {
    parts.push(`displayName: ${record.displayName}`);
  }
  if (record.lastSeenAt) {
    parts.push(`lastSeenAt: ${record.lastSeenAt}`);
  }
  if (record.latestMessage) {
    parts.push(`latestMessage: ${record.latestMessage}`);
  }
  return parts.join(' / ');
}

export function buildRegisterVisitorPrompt({ text, pendingVisitors, personEntries }) {
  const pendingSummary = pendingVisitors.length > 0
    ? pendingVisitors.map((record) => `- ${formatPendingVisitorSummary(record)}`).join('\n')
    : '- pending visitor なし';
  const personSummary = personEntries.length > 0
    ? personEntries
      .map((entry) => {
        const aliases = Array.isArray(entry.aliases) && entry.aliases.length > 0 ? ` / aliases: ${entry.aliases.join(', ')}` : '';
        return `- id: ${entry.id} / name: ${entry.name}${aliases} / description: ${entry.description}`;
      })
      .join('\n')
    : '- person 候補なし';

  return [
    'あなたは LINE visitor 登録プランナーです。',
    '',
    '目的:',
    '- owner の自然文を解釈して、未登録 visitor を memory の person へ紐付ける更新計画を作る',
    '- pending visitor が複数いる場合や人物候補が曖昧な場合は clarify にする',
    '',
    'ルール:',
    '- JSON オブジェクトのみを返す',
    '- pendingVisitorUserId は pending visitor 一覧にある userId だけを使う',
    '- personId は person candidate 一覧にある id だけを使う。曖昧なら空文字にして clarify',
    '- personName は必要なときだけ補助的に使う。personId を優先する',
    '- role, relationshipToOwner, scopePolicy は owner が自然文で明示したときだけ update フラグを true にする',
    '- 明示されていない値を勝手に補完しない',
    '- 「さっきの人」は最新の pending visitor を指す',
    '',
    '[pending visitors]',
    pendingSummary,
    '',
    '[person candidates]',
    personSummary,
    '',
    'owner メッセージ:',
    text
  ].join('\n');
}

function normalizePendingVisitorUserId(rawUserId, pendingVisitors) {
  const normalizedUserId = normalizeString(rawUserId, 120);
  if (!normalizedUserId) {
    return pendingVisitors[0]?.lineUserId || '';
  }
  return normalizedUserId;
}

function findPersonNode({ personId, personName, personNodes }) {
  const normalizedPersonId = normalizeString(personId, 120);
  if (normalizedPersonId) {
    const byId = personNodes.find((node) => node.entry.id === normalizedPersonId);
    return byId ? { node: byId, ambiguous: false } : { node: null, ambiguous: false };
  }

  const normalizedPersonName = normalizeString(personName, 200).toLowerCase();
  if (!normalizedPersonName) {
    return { node: null, ambiguous: false };
  }

  const matches = personNodes.filter((node) => {
    const names = [
      node.entry.name,
      ...(Array.isArray(node.entry.aliases) ? node.entry.aliases : []),
      node.frontmatter.name
    ]
      .map((name) => normalizeString(name, 200).toLowerCase())
      .filter(Boolean);
    return names.includes(normalizedPersonName);
  });

  if (matches.length !== 1) {
    return { node: null, ambiguous: matches.length > 1 };
  }

  return { node: matches[0], ambiguous: false };
}

function buildUpdatedPersonFrontmatter(frontmatter, registrationPlan, lineUserId) {
  const nextFrontmatter =
    frontmatter && typeof frontmatter === 'object' && !Array.isArray(frontmatter)
      ? { ...frontmatter }
      : {};
  const identities =
    nextFrontmatter.identities && typeof nextFrontmatter.identities === 'object' && !Array.isArray(nextFrontmatter.identities)
      ? { ...nextFrontmatter.identities }
      : {};

  identities.lineUserIds = Array.from(new Set([
    ...normalizeLineUserIds(nextFrontmatter),
    lineUserId
  ]));
  nextFrontmatter.identities = identities;

  if (registrationPlan.updateRole) {
    nextFrontmatter.role = normalizeString(registrationPlan.role, 120);
  }
  if (registrationPlan.updateRelationshipToOwner) {
    nextFrontmatter.relationshipToOwner = normalizeString(registrationPlan.relationshipToOwner, 120);
  }
  if (registrationPlan.updateScopePolicy) {
    nextFrontmatter.scopePolicy = normalizeScopePolicy(registrationPlan.scopePolicy);
  }

  return nextFrontmatter;
}

export async function registerVisitorFromOwnerText({ text, profileContext }, deps = {}) {
  const readVisitorRegistrationStateFn = deps.readVisitorRegistrationState || readVisitorRegistrationState;
  const writeVisitorRegistrationStateFn = deps.writeVisitorRegistrationState || writeVisitorRegistrationState;
  const loadMemoryStoreFn = deps.loadMemoryStore || loadMemoryStore;
  const readMemoryNodeContentFn = deps.readMemoryNodeContent || readMemoryNodeContent;
  const writeTextFileInDriveSubfolderFn = deps.writeTextFileInDriveSubfolder || writeTextFileInDriveSubfolder;
  const createStructuredOutputFn = deps.createStructuredOutput || createStructuredOutput;

  const state = await readVisitorRegistrationStateFn();
  const pendingVisitors = listPendingVisitors(state);
  if (pendingVisitors.length === 0) {
    return {
      outcome: 'clarify',
      message: '登録待ちの visitor は見つかりませんでした。'
    };
  }

  const { memoryStore, personNodes } = await loadPeopleNodes({
    loadMemoryStoreFn,
    readMemoryNodeContentFn
  });
  const personEntries = memoryStore.registryEntries.filter((entry) => entry.type === 'person' && entry.path.startsWith('people/'));

  const registrationPlan = await createStructuredOutputFn({
    model: config.openai.taskModel,
    schemaName: 'register_visitor_result',
    schema: REGISTER_VISITOR_SCHEMA,
    systemPrompt: '必ずスキーマに一致する正しいJSONオブジェクトだけを返してください。',
    profileContext,
    userPrompt: buildRegisterVisitorPrompt({ text, pendingVisitors, personEntries })
  });

  if (registrationPlan.outcome === 'clarify') {
    return {
      outcome: 'clarify',
      message: normalizeString(registrationPlan.message, 500) || 'どの visitor を誰として登録するか確認させてください。'
    };
  }

  const pendingVisitorUserId = normalizePendingVisitorUserId(
    registrationPlan.pendingVisitorUserId,
    pendingVisitors
  );
  const pendingRecord = state.pendingVisitors?.[pendingVisitorUserId];
  if (!pendingRecord || pendingRecord.status !== 'pending') {
    return {
      outcome: 'clarify',
      message: '登録対象の visitor を特定できませんでした。'
    };
  }

  const personMatch = findPersonNode({
    personId: registrationPlan.personId,
    personName: registrationPlan.personName,
    personNodes
  });
  if (!personMatch.node) {
    return {
      outcome: 'clarify',
      message: personMatch.ambiguous
        ? '登録先の人物候補が複数あります。person をもう少し具体的に指定してください。'
        : '登録先の人物を特定できませんでした。'
    };
  }

  const conflictingNode = personNodes.find((node) => {
    return node.entry.id !== personMatch.node.entry.id
      && normalizeLineUserIds(node.frontmatter).includes(pendingVisitorUserId);
  });
  if (conflictingNode) {
    return {
      outcome: 'clarify',
      message: `${pendingVisitorUserId} はすでに ${conflictingNode.entry.name} に登録されています。`
    };
  }

  const updatedFrontmatter = buildUpdatedPersonFrontmatter(
    personMatch.node.frontmatter,
    registrationPlan,
    pendingVisitorUserId
  );
  const nextMarkdown = stringifyMemoryMarkdown({
    frontmatter: updatedFrontmatter,
    body: personMatch.node.body
  });

  await writeTextFileInDriveSubfolderFn({
    folderName: config.googleDrive.memoryFolderName,
    relativePath: personMatch.node.entry.path,
    content: nextMarkdown,
    mimeType: 'text/markdown'
  });

  const nextState = {
    pendingVisitors: {
      ...normalizePendingVisitors(state.pendingVisitors),
      [pendingVisitorUserId]: {
        ...pendingRecord,
        status: 'registered',
        registeredPersonId: personMatch.node.entry.id
      }
    }
  };
  await writeVisitorRegistrationStateFn(nextState);

  return {
    outcome: 'updated',
    message: normalizeString(registrationPlan.message, 500)
      || `${personMatch.node.entry.name} として登録しました。`,
    registeredPersonId: personMatch.node.entry.id,
    pendingVisitorUserId
  };
}

export function buildOwnerPendingVisitorNotification({ lineUserId, displayName, latestMessage }) {
  const lines = [
    '未登録 visitor からメッセージが来ました。'
  ];
  if (displayName) {
    lines.push(`表示名: ${displayName}`);
  }
  lines.push(`userId: ${lineUserId}`);
  if (latestMessage) {
    lines.push(`最新メッセージ: ${latestMessage}`);
  }
  lines.push('登録するなら「さっきの人を山本圭亮として登録して」のように送ってください。');
  return lines.join('\n');
}

export async function ensurePendingVisitorRegistered({ lineUserId, latestMessage, ownerUserId, now }, deps = {}) {
  const readVisitorRegistrationStateFn = deps.readVisitorRegistrationState || readVisitorRegistrationState;
  const writeVisitorRegistrationStateFn = deps.writeVisitorRegistrationState || writeVisitorRegistrationState;
  const getUserProfileFn = deps.getUserProfile || getUserProfile;
  const pushMessageFn = deps.pushMessage || pushMessage;
  const normalizedLineUserId = normalizeString(lineUserId, 120);
  const normalizedOwnerUserId = normalizeString(ownerUserId, 120);
  const seenAt = String(now || new Date().toISOString()).trim();
  if (!normalizedLineUserId) {
    return null;
  }

  const state = await readVisitorRegistrationStateFn();
  const existingRecord = state.pendingVisitors?.[normalizedLineUserId];
  let displayName = normalizeString(existingRecord?.displayName || '', 120);
  if (!displayName) {
    try {
      const profile = await getUserProfileFn(normalizedLineUserId);
      displayName = normalizeString(profile?.displayName || '', 120);
    } catch (error) {
      console.error('[visitor-registration] failed to load line profile', {
        lineUserId: normalizedLineUserId,
        error: String(error?.message || error)
      });
    }
  }

  const nextRecord = {
    lineUserId: normalizedLineUserId,
    displayName,
    latestMessage: normalizeString(latestMessage, 5000),
    lastSeenAt: seenAt,
    lastNotifiedAt: String(existingRecord?.lastNotifiedAt || '').trim(),
    status: 'pending',
    registeredPersonId: ''
  };

  const shouldNotify = normalizedOwnerUserId && !nextRecord.lastNotifiedAt;
  if (shouldNotify) {
    try {
      await pushMessageFn(normalizedOwnerUserId, buildOwnerPendingVisitorNotification(nextRecord));
      nextRecord.lastNotifiedAt = seenAt;
    } catch (error) {
      console.error('[visitor-registration] failed to notify owner', {
        lineUserId: normalizedLineUserId,
        ownerUserId: normalizedOwnerUserId,
        error: String(error?.message || error)
      });
    }
  }

  await writeVisitorRegistrationStateFn({
    pendingVisitors: {
      ...normalizePendingVisitors(state.pendingVisitors),
      [normalizedLineUserId]: nextRecord
    }
  });

  return nextRecord;
}

export function buildVisitorPermissionReviewPrompt({
  text,
  visitorIdentity,
  candidateReply,
  sources,
  evaluatedSources
}) {
  const visitorSummary = visitorIdentity.status === 'registered'
    ? [
      `status: registered`,
      `personId: ${visitorIdentity.personId}`,
      `name: ${visitorIdentity.personSummary?.name || ''}`,
      `role: ${visitorIdentity.personSummary?.role || '(unset)'}`,
      `relationshipToOwner: ${visitorIdentity.personSummary?.relationshipToOwner || '(unset)'}`,
      `allowedScopes: ${(visitorIdentity.scopePolicy?.allowedScopes || []).join(', ') || '(none)'}`
    ].join('\n')
    : `status: ${visitorIdentity.status}`;
  const sourceSummary = evaluatedSources.length > 0
    ? evaluatedSources.map((source) => {
      const scopes = Array.isArray(source.scopes) && source.scopes.length > 0 ? source.scopes.join(', ') : '(none)';
      return `- kind: ${source.kind} / sourceId: ${source.sourceId} / scopes: ${scopes} / allowed: ${source.allowed ? 'yes' : 'no'} / summary: ${source.summary}`;
    }).join('\n')
    : '- source なし';

  return [
    'あなたは visitor 向け権限レビュー担当です。',
    '',
    '目的:',
    '- candidate reply をそのまま返さず、この visitor に見せてよい内容だけへ書き直す',
    '',
    'ルール:',
    '- JSON オブジェクトのみを返す',
    '- allowed=no の source に依存する具体情報は返さない',
    '- 情報全体が不許可なら deny にする',
    '- 一部だけ許可できるなら redact にして、許可範囲だけ残す',
    '- 一般応答で owner 固有情報に依存していないなら allow でよい',
    '- 実行したふりをしない',
    '',
    '[visitor]',
    visitorSummary,
    '',
    '[candidate reply]',
    candidateReply,
    '',
    '[source access review]',
    sourceSummary,
    '',
    '最新の visitor メッセージ:',
    text
  ].join('\n');
}

function isSourceAllowedForVisitor(source, visitorIdentity) {
  if (source.kind === 'general') {
    return true;
  }

  if (visitorIdentity.status !== 'registered') {
    return false;
  }

  const allowedScopes = new Set(visitorIdentity.scopePolicy?.allowedScopes || []);
  const sourceScopes = Array.isArray(source.scopes) && source.scopes.length > 0
    ? source.scopes
    : source.scope
      ? [source.scope]
      : [];
  if (sourceScopes.length === 0) {
    return false;
  }

  return sourceScopes.some((scope) => allowedScopes.has(scope));
}

function normalizeReviewedMessage(message, fallback) {
  const normalized = String(message || '').trim().replace(/\r\n/g, '\n').slice(0, 5000);
  return normalized || fallback;
}

export async function reviewVisitorReply(
  { text, candidateReply, visitorIdentity, sources, profileContext },
  deps = {}
) {
  const createStructuredOutputFn = deps.createStructuredOutput || createStructuredOutput;
  const normalizedSources = Array.isArray(sources)
    ? sources.map((source) => ({
      kind: normalizeString(source.kind, 40) || 'general',
      sourceId: normalizeString(source.sourceId, 120) || 'source',
      scope: normalizeString(source.scope, 120),
      scopes: Array.isArray(source.scopes)
        ? Array.from(new Set(source.scopes.map((scope) => normalizeString(scope, 120)).filter(Boolean)))
        : [],
      summary: normalizeString(source.summary, 400)
    }))
    : [];
  const evaluatedSources = normalizedSources.map((source) => ({
    ...source,
    allowed: isSourceAllowedForVisitor(source, visitorIdentity)
  }));
  const hasDeniedOwnerSource = evaluatedSources.some((source) => source.kind !== 'general' && !source.allowed);
  const hasAllowedOwnerSource = evaluatedSources.some((source) => source.kind !== 'general' && source.allowed);
  const fallbackDecision = hasDeniedOwnerSource && !hasAllowedOwnerSource ? 'deny' : 'allow';
  const fallbackMessage = hasDeniedOwnerSource && !hasAllowedOwnerSource
    ? (visitorIdentity.status === 'unregistered' ? UNREGISTERED_VISITOR_MESSAGE : OWNER_INFO_DENIED_MESSAGE)
    : normalizeReviewedMessage(candidateReply, OWNER_INFO_DENIED_MESSAGE);

  try {
    const reviewed = await createStructuredOutputFn({
      model: config.openai.taskModel,
      schemaName: 'visitor_permission_review',
      schema: VISITOR_PERMISSION_REVIEW_SCHEMA,
      systemPrompt: '必ずスキーマに一致する正しいJSONオブジェクトだけを返してください。',
      profileContext,
      userPrompt: buildVisitorPermissionReviewPrompt({
        text,
        visitorIdentity,
        candidateReply,
        sources: normalizedSources,
        evaluatedSources
      })
    });

    if (hasDeniedOwnerSource && !hasAllowedOwnerSource) {
      return {
        decision: 'deny',
        message: fallbackMessage,
        sources: evaluatedSources
      };
    }

    return {
      decision: reviewed.decision,
      message: normalizeReviewedMessage(
        reviewed.message,
        reviewed.decision === 'deny' ? OWNER_INFO_DENIED_MESSAGE : fallbackMessage
      ),
      sources: evaluatedSources
    };
  } catch (error) {
    console.error('[visitor-review] failed', {
      lineUserId: visitorIdentity.lineUserId,
      error: String(error?.message || error)
    });
    return {
      decision: fallbackDecision,
      message: fallbackMessage,
      sources: evaluatedSources
    };
  }
}

export function buildAgendaSources(events) {
  return Array.isArray(events)
    ? events.map((event) => ({
      kind: 'agenda',
      sourceId: normalizeString(event.eventId, 120) || 'agenda-item',
      scope: 'owner.today_agenda.basic',
      scopes: ['owner.today_agenda.basic'],
      summary: `${event.allDay ? '終日' : `${String(event.startTime || '').slice(0, 5)}-${String(event.endTime || '').slice(0, 5)}`} ${event.title}`
    }))
    : [];
}

export function buildGeneralReplySource() {
  return {
    kind: 'general',
    sourceId: 'general-reply',
    scope: '',
    scopes: [],
    summary: 'owner 固有情報に依存しない一般応答'
  };
}

export function buildMemorySources(nodes) {
  return Array.isArray(nodes)
    ? nodes.map((node) => {
      const scopes = normalizeMemoryAccessScopes(node.frontmatter?.access);
      return {
        kind: 'memory',
        sourceId: normalizeString(node.entry?.id, 120) || 'memory-node',
        scope: scopes[0] || '',
        scopes,
        summary: normalizeString(
          node.entry?.description || node.frontmatter?.description || node.body || '',
          280
        )
      };
    })
    : [];
}
