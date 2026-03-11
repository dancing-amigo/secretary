import test from 'node:test';
import assert from 'node:assert/strict';

import {
  answerFromMemory,
  buildMemoryReplyPrompt,
  buildSecondarySelectionPrompt,
  normalizeMemorySelectionIds
} from '../src/services/memoryAgent.js';
import {
  normalizeMemoryRegistryEntry,
  parseMemoryFrontmatter,
  resolveLinkedRegistryEntries
} from '../src/services/memoryStore.js';

test('normalizeMemoryRegistryEntry keeps id/name/aliases/description/type/path', () => {
  const entry = normalizeMemoryRegistryEntry({
    id: 'club-history',
    name: '部活の記録',
    aliases: ['部活', 'サークル'],
    description: '大学時代の活動記録',
    type: 'event',
    path: 'memory/events/club-history.md'
  });

  assert.deepEqual(entry, {
    id: 'club-history',
    name: '部活の記録',
    aliases: ['部活', 'サークル'],
    description: '大学時代の活動記録',
    type: 'event',
    path: 'events/club-history.md'
  });
});

test('parseMemoryFrontmatter reads body and frontmatter links', () => {
  const parsed = parseMemoryFrontmatter([
    '---',
    'links:',
    '  - related-node',
    'summary: test',
    '---',
    '',
    '本文です。'
  ].join('\n'));

  assert.deepEqual(parsed.frontmatter.links, ['related-node']);
  assert.equal(parsed.body, '本文です。');
});

test('resolveLinkedRegistryEntries only returns linked registry nodes', () => {
  const registryById = new Map([
    ['related-node', { id: 'related-node', path: 'nodes/related.md', aliases: [], name: '関連', description: '関連ノード', type: 'fact' }],
    ['other-node', { id: 'other-node', path: 'nodes/other.md', aliases: [], name: '別', description: '別ノード', type: 'fact' }]
  ]);
  const registryByPath = new Map([
    ['nodes/related.md', registryById.get('related-node')],
    ['nodes/other.md', registryById.get('other-node')]
  ]);

  const linked = resolveLinkedRegistryEntries({
    links: ['related-node']
  }, registryById, registryByPath);

  assert.deepEqual(linked.map((entry) => entry.id), ['related-node']);
});

test('normalizeMemorySelectionIds enforces allowed ids and limit', () => {
  const selected = normalizeMemorySelectionIds([
    { nodeId: 'a', reason: '1' },
    { nodeId: 'b', reason: '2' },
    { nodeId: 'c', reason: '3' },
    { nodeId: 'd', reason: '4' },
    { nodeId: 'x', reason: 'skip' }
  ], ['a', 'b', 'c', 'd'], 3);

  assert.deepEqual(selected.map((entry) => entry.nodeId), ['a', 'b', 'c']);
});

test('buildSecondarySelectionPrompt includes primary body and link constraints', () => {
  const primaryNodes = [{
    entry: {
      id: 'primary-1',
      name: '大学',
      type: 'profile',
      description: '大学の記憶',
      path: 'profiles/college.md'
    },
    body: '大学時代は演劇サークルに所属していた。',
    links: ['club-node']
  }];
  const linkedEntriesByPrimaryId = new Map([
    ['primary-1', [{
      id: 'club-node',
      name: '演劇サークル',
      type: 'group',
      description: '演劇サークルの情報',
      aliases: ['劇団']
    }]]
  ]);

  const prompt = buildSecondarySelectionPrompt({
    text: '大学時代の活動を教えて',
    dateKey: '2026-03-10',
    localTime: '12:00:00',
    timeZone: 'America/Vancouver',
    conversationText: '- 会話履歴なし',
    primaryNodes,
    linkedEntriesByPrimaryId
  });

  assert.match(prompt, /大学時代は演劇サークルに所属していた。/);
  assert.match(prompt, /secondary 候補は primary ノード frontmatter の links に含まれる node だけに限定する/);
  assert.match(prompt, /id: club-node/);
});

test('buildMemoryReplyPrompt instructs model not to guess when no nodes were found', () => {
  const prompt = buildMemoryReplyPrompt({
    text: 'その件どうだった？',
    dateKey: '2026-03-10',
    localTime: '12:00:00',
    timeZone: 'America/Vancouver',
    conversationText: '- 会話履歴なし',
    primaryNodes: [],
    secondaryNodes: []
  });

  assert.match(prompt, /情報が見つからない場合は、その旨を明確に伝える/);
  assert.match(prompt, /relevant memory nodes: none/);
});

test('answerFromMemory limits primary and secondary nodes and reads secondary only from linked candidates', async () => {
  const registryEntries = [
    { id: 'p1', name: 'P1', aliases: [], description: 'd1', type: 'profile', path: 'p1.md' },
    { id: 'p2', name: 'P2', aliases: [], description: 'd2', type: 'profile', path: 'p2.md' },
    { id: 'p3', name: 'P3', aliases: [], description: 'd3', type: 'profile', path: 'p3.md' },
    { id: 'p4', name: 'P4', aliases: [], description: 'd4', type: 'profile', path: 'p4.md' },
    { id: 's1', name: 'S1', aliases: [], description: 'sd1', type: 'detail', path: 's1.md' },
    { id: 's2', name: 'S2', aliases: [], description: 'sd2', type: 'detail', path: 's2.md' },
    { id: 's3', name: 'S3', aliases: [], description: 'sd3', type: 'detail', path: 's3.md' },
    { id: 's4', name: 'S4', aliases: [], description: 'sd4', type: 'detail', path: 's4.md' }
  ];
  const registryById = new Map(registryEntries.map((entry) => [entry.id, entry]));
  const registryByPath = new Map(registryEntries.map((entry) => [entry.path, entry]));
  const readCalls = [];
  const structuredCalls = [];

  const reply = await answerFromMemory({
    text: '大学時代の活動を教えて',
    conversationContext: { text: '- 会話履歴なし' },
    dateContext: { dateKey: '2026-03-10', localTime: '12:00:00', timeZone: 'America/Vancouver' }
  }, {
    loadMemoryStore: async () => ({
      indexMarkdown: '# memory index',
      registryEntries,
      registryById,
      registryByPath
    }),
    readMemoryNodeContent: async (entry) => {
      readCalls.push(entry.id);
      return {
        entry,
        body: `${entry.id} body`,
        frontmatter: {},
        links: entry.id === 'p1'
          ? ['s1', 's2']
          : entry.id === 'p2'
            ? ['s3']
            : entry.id === 'p3'
              ? ['s4']
              : []
      };
    },
    createStructuredOutput: async ({ schemaName, userPrompt }) => {
      structuredCalls.push({ schemaName, userPrompt });
      if (schemaName === 'memory_primary_selection') {
        return {
          nodes: [
            { nodeId: 'p1', reason: '1' },
            { nodeId: 'p2', reason: '2' },
            { nodeId: 'p3', reason: '3' },
            { nodeId: 'p4', reason: '4' }
          ]
        };
      }

      return {
        nodes: [
          { nodeId: 's1', reason: '1' },
          { nodeId: 's2', reason: '2' },
          { nodeId: 's3', reason: '3' },
          { nodeId: 's4', reason: '4' },
          { nodeId: 'p4', reason: 'invalid' }
        ]
      };
    },
    createTextOutput: async ({ userPrompt }) => {
      assert.match(userPrompt, /### node-1/);
      assert.doesNotMatch(userPrompt, /s4 body/);
      return '記憶ベースの返答です。';
    }
  });

  assert.equal(reply, '記憶ベースの返答です。');
  assert.deepEqual(readCalls, ['p1', 'p2', 'p3', 's1', 's2', 's3']);
  assert.deepEqual(structuredCalls.map((call) => call.schemaName), [
    'memory_primary_selection',
    'memory_secondary_selection'
  ]);
  assert.match(structuredCalls[1].userPrompt, /p1 body/);
});

test('answerFromMemory falls back to generic error message on store failure', async () => {
  const reply = await answerFromMemory({
    text: '覚えてる？',
    conversationContext: { text: '- 会話履歴なし' },
    dateContext: { dateKey: '2026-03-10', localTime: '12:00:00', timeZone: 'America/Vancouver' }
  }, {
    loadMemoryStore: async () => {
      throw new Error('drive unavailable');
    }
  });

  assert.equal(reply, '関連する記憶を確認できませんでした。少し置いてからもう一度聞いてください。');
});

test('answerFromMemory still builds a no-info reply when no relevant nodes were found', async () => {
  let capturedPrompt = '';

  const reply = await answerFromMemory({
    text: 'わかる？',
    conversationContext: { text: '- 会話履歴なし' },
    dateContext: { dateKey: '2026-03-10', localTime: '12:00:00', timeZone: 'America/Vancouver' }
  }, {
    loadMemoryStore: async () => ({
      indexMarkdown: '# memory index',
      registryEntries: [],
      registryById: new Map(),
      registryByPath: new Map()
    }),
    createStructuredOutput: async () => ({ nodes: [] }),
    createTextOutput: async ({ userPrompt }) => {
      capturedPrompt = userPrompt;
      return '見つかりませんでした。';
    }
  });

  assert.equal(reply, '見つかりませんでした。');
  assert.match(capturedPrompt, /情報が見つからない場合は、その旨を明確に伝える/);
  assert.match(capturedPrompt, /relevant memory nodes: none/);
});
