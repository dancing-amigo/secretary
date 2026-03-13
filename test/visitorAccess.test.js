import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AMBIGUOUS_VISITOR_MESSAGE,
  OWNER_INFO_DENIED_MESSAGE,
  UNREGISTERED_VISITOR_MESSAGE,
  buildAgendaSources,
  buildOwnerPendingVisitorNotification,
  normalizeLineUserIds,
  normalizeScopePolicy,
  registerVisitorFromOwnerText,
  resolveVisitorIdentity,
  reviewVisitorReply,
  ensurePendingVisitorRegistered
} from '../src/services/visitorAccess.js';

test('normalizeLineUserIds reads array and legacy singular field', () => {
  assert.deepEqual(
    normalizeLineUserIds({
      identities: {
        lineUserIds: ['U1', ' U2 '],
        lineUserId: 'ignored'
      }
    }),
    ['U1', 'U2']
  );

  assert.deepEqual(
    normalizeLineUserIds({
      identities: {
        lineUserId: 'U3'
      }
    }),
    ['U3']
  );
});

test('normalizeScopePolicy keeps only deduplicated allowed scopes', () => {
  assert.deepEqual(
    normalizeScopePolicy({
      allowedScopes: ['owner.today_agenda.basic', ' owner.today_agenda.basic ', 'owner.memory.people']
    }),
    {
      allowedScopes: ['owner.today_agenda.basic', 'owner.memory.people']
    }
  );
});

test('resolveVisitorIdentity returns registered, unregistered, and ambiguous states', async () => {
  const personEntries = [
    { id: 'keisuke-yamamoto', name: 'Keisuke Yamamoto', aliases: ['山本圭亮'], description: '友人', type: 'person', path: 'people/keisuke-yamamoto.md' },
    { id: 'another', name: 'Another', aliases: [], description: '別人', type: 'person', path: 'people/another.md' }
  ];
  const personNodes = new Map([
    ['keisuke-yamamoto', {
      entry: personEntries[0],
      body: 'body',
      frontmatter: {
        role: 'friend',
        relationshipToOwner: 'friend',
        identities: { lineUserIds: ['U-keisuke'] },
        scopePolicy: { allowedScopes: ['owner.today_agenda.basic'] }
      }
    }],
    ['another', {
      entry: personEntries[1],
      body: 'body',
      frontmatter: {
        identities: { lineUserIds: ['U-dup', 'U-keisuke'] }
      }
    }]
  ]);

  const deps = {
    loadMemoryStore: async () => ({
      registryEntries: personEntries
    }),
    readMemoryNodeContent: async (entry) => personNodes.get(entry.id)
  };

  const ambiguous = await resolveVisitorIdentity({ lineUserId: 'U-keisuke' }, deps);
  assert.equal(ambiguous.status, 'ambiguous');

  personNodes.get('another').frontmatter.identities.lineUserIds = ['U-dup'];
  const registered = await resolveVisitorIdentity({ lineUserId: 'U-keisuke' }, deps);
  assert.equal(registered.status, 'registered');
  assert.equal(registered.personId, 'keisuke-yamamoto');
  assert.deepEqual(registered.scopePolicy.allowedScopes, ['owner.today_agenda.basic']);

  const unregistered = await resolveVisitorIdentity({ lineUserId: 'U-none' }, deps);
  assert.equal(unregistered.status, 'unregistered');
});

test('buildOwnerPendingVisitorNotification includes displayName and instruction', () => {
  const message = buildOwnerPendingVisitorNotification({
    lineUserId: 'U-1',
    displayName: 'Keisuke',
    latestMessage: '今日の予定は？'
  });

  assert.match(message, /未登録 visitor/);
  assert.match(message, /Keisuke/);
  assert.match(message, /今日の予定は？/);
  assert.match(message, /さっきの人を山本圭亮として登録して/);
});

test('ensurePendingVisitorRegistered notifies owner only once per pending visitor', async () => {
  const writes = [];
  const pushes = [];
  let state = { pendingVisitors: {} };

  const deps = {
    readVisitorRegistrationState: async () => state,
    writeVisitorRegistrationState: async (nextState) => {
      state = nextState;
      writes.push(nextState);
    },
    getUserProfile: async () => ({ displayName: 'Keisuke' }),
    pushMessage: async (userId, text) => {
      pushes.push([userId, text]);
    }
  };

  await ensurePendingVisitorRegistered({
    lineUserId: 'U-1',
    latestMessage: 'first',
    ownerUserId: 'owner-1',
    now: '2026-03-12T09:00:00Z'
  }, deps);
  await ensurePendingVisitorRegistered({
    lineUserId: 'U-1',
    latestMessage: 'second',
    ownerUserId: 'owner-1',
    now: '2026-03-12T09:05:00Z'
  }, deps);

  assert.equal(pushes.length, 1);
  assert.equal(writes.length, 2);
  assert.equal(state.pendingVisitors['U-1'].latestMessage, 'second');
  assert.equal(state.pendingVisitors['U-1'].displayName, 'Keisuke');
});

test('registerVisitorFromOwnerText updates matching people frontmatter and marks visitor registered', async () => {
  let state = {
    pendingVisitors: {
      'U-1': {
        lineUserId: 'U-1',
        displayName: 'Keisuke',
        latestMessage: 'hello',
        lastSeenAt: '2026-03-12T09:00:00Z',
        lastNotifiedAt: '2026-03-12T09:00:00Z',
        status: 'pending',
        registeredPersonId: ''
      }
    }
  };
  const writes = [];
  const personEntry = {
    id: 'keisuke-yamamoto',
    name: 'Keisuke Yamamoto',
    aliases: ['山本圭亮'],
    description: '友人',
    type: 'person',
    path: 'people/keisuke-yamamoto.md'
  };
  const personNode = {
    entry: personEntry,
    body: '# Keisuke Yamamoto\n',
    frontmatter: {
      id: 'keisuke-yamamoto',
      type: 'person',
      name: 'Keisuke Yamamoto',
      identities: { lineUserIds: [] },
      role: 'friend'
    }
  };

  const result = await registerVisitorFromOwnerText({
    text: 'さっきの人を山本圭亮として登録して',
    profileContext: { scope: 'owner_readonly' }
  }, {
    readVisitorRegistrationState: async () => state,
    writeVisitorRegistrationState: async (nextState) => {
      state = nextState;
    },
    loadMemoryStore: async () => ({
      registryEntries: [personEntry]
    }),
    readMemoryNodeContent: async () => personNode,
    createStructuredOutput: async () => ({
      outcome: 'updated',
      pendingVisitorUserId: '',
      personId: 'keisuke-yamamoto',
      personName: '',
      updateRole: false,
      role: '',
      updateRelationshipToOwner: false,
      relationshipToOwner: '',
      updateScopePolicy: false,
      scopePolicy: { allowedScopes: [] },
      message: '登録しました。'
    }),
    writeTextFileInDriveSubfolder: async (payload) => {
      writes.push(payload);
    }
  });

  assert.equal(result.outcome, 'updated');
  assert.equal(writes.length, 1);
  assert.match(writes[0].content, /lineUserIds:/);
  assert.match(writes[0].content, /U-1/);
  assert.equal(state.pendingVisitors['U-1'].status, 'registered');
  assert.equal(state.pendingVisitors['U-1'].registeredPersonId, 'keisuke-yamamoto');
});

test('registerVisitorFromOwnerText rejects conflicts where lineUserId is already registered elsewhere', async () => {
  const state = {
    pendingVisitors: {
      'U-1': {
        lineUserId: 'U-1',
        displayName: '',
        latestMessage: 'hello',
        lastSeenAt: '2026-03-12T09:00:00Z',
        lastNotifiedAt: '2026-03-12T09:00:00Z',
        status: 'pending',
        registeredPersonId: ''
      }
    }
  };
  const entries = [
    { id: 'target', name: 'Target', aliases: [], description: 'target', type: 'person', path: 'people/target.md' },
    { id: 'other', name: 'Other', aliases: [], description: 'other', type: 'person', path: 'people/other.md' }
  ];
  const nodes = {
    target: { entry: entries[0], body: '', frontmatter: { identities: { lineUserIds: [] } } },
    other: { entry: entries[1], body: '', frontmatter: { identities: { lineUserIds: ['U-1'] } } }
  };

  const result = await registerVisitorFromOwnerText({
    text: 'さっきの人を Target として登録して',
    profileContext: {}
  }, {
    readVisitorRegistrationState: async () => state,
    writeVisitorRegistrationState: async () => {
      throw new Error('should not write');
    },
    loadMemoryStore: async () => ({
      registryEntries: entries
    }),
    readMemoryNodeContent: async (entry) => nodes[entry.id],
    createStructuredOutput: async () => ({
      outcome: 'updated',
      pendingVisitorUserId: 'U-1',
      personId: 'target',
      personName: '',
      updateRole: false,
      role: '',
      updateRelationshipToOwner: false,
      relationshipToOwner: '',
      updateScopePolicy: false,
      scopePolicy: { allowedScopes: [] },
      message: '登録しました。'
    })
  });

  assert.equal(result.outcome, 'clarify');
  assert.match(result.message, /すでに/);
});

test('reviewVisitorReply falls back to deny for unregistered owner sources and allows general replies', async () => {
  const denied = await reviewVisitorReply({
    text: '予定は？',
    candidateReply: '10:00 に打ち合わせです。',
    visitorIdentity: {
      status: 'unregistered',
      lineUserId: 'U-1',
      personId: '',
      personSummary: null,
      scopePolicy: { allowedScopes: [] }
    },
    sources: buildAgendaSources([
      {
        eventId: 'evt-1',
        title: '打ち合わせ',
        allDay: false,
        startTime: '10:00:00',
        endTime: '11:00:00'
      }
    ]),
    profileContext: {}
  }, {
    createStructuredOutput: async () => {
      throw new Error('llm down');
    }
  });

  assert.equal(denied.decision, 'deny');
  assert.equal(denied.message, UNREGISTERED_VISITOR_MESSAGE);

  const allowed = await reviewVisitorReply({
    text: 'こんにちは',
    candidateReply: 'こんにちは',
    visitorIdentity: {
      status: 'unregistered',
      lineUserId: 'U-1',
      personId: '',
      personSummary: null,
      scopePolicy: { allowedScopes: [] }
    },
    sources: [{
      kind: 'general',
      sourceId: 'general',
      scope: '',
      scopes: [],
      summary: 'general'
    }],
    profileContext: {}
  }, {
    createStructuredOutput: async () => {
      throw new Error('llm down');
    }
  });

  assert.equal(allowed.decision, 'allow');
  assert.equal(allowed.message, 'こんにちは');
  assert.notEqual(UNREGISTERED_VISITOR_MESSAGE, OWNER_INFO_DENIED_MESSAGE);
  assert.notEqual(AMBIGUOUS_VISITOR_MESSAGE, OWNER_INFO_DENIED_MESSAGE);
});
