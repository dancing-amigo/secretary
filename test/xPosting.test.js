import test from 'node:test';
import assert from 'node:assert/strict';

import {
  appendXMention,
  buildDailyXPostPrompt,
  generateDailyXPostText,
  buildXMentionSuffix,
  normalizeXPostText
} from '../src/services/assistantEngine.js';
import {
  buildNightXPostFailureNotice,
  shouldAttemptDailyXPost
} from '../src/services/xPosting.js';

test('normalizeXPostText removes wrappers and enforces 280 code points', () => {
  const output = normalizeXPostText('\n「今日は進みました」\n');
  assert.equal(output, '今日は進みました');

  const long = `「${'あ'.repeat(400)}」`;
  assert.equal(Array.from(normalizeXPostText(long)).length, 280);
});

test('normalizeXPostText returns empty string when model output is empty', () => {
  assert.equal(normalizeXPostText('   '), '');
});

test('appendXMention appends a configurable mention within 280 code points', () => {
  assert.equal(buildXMentionSuffix('dancing_amigo'), ' @dancing_amigo');
  assert.equal(buildXMentionSuffix('@dancing_amigo'), ' @dancing_amigo');
  assert.equal(appendXMention('今日は進みました。', 'dancing_amigo'), '今日は進みました。 @dancing_amigo');

  const long = 'あ'.repeat(280);
  const output = appendXMention(long, 'dancing_amigo');
  assert.equal(Array.from(output).length, 280);
  assert.match(output, / @dancing_amigo$/);
});

test('shouldAttemptDailyXPost returns false once a daily post was attempted', () => {
  assert.equal(shouldAttemptDailyXPost(null), true);
  assert.equal(shouldAttemptDailyXPost({}), true);
  assert.equal(shouldAttemptDailyXPost({ xPostAttemptedAt: '2026-03-11T03:00:00Z' }), false);
  assert.equal(shouldAttemptDailyXPost({ xPostStatus: 'failed' }), false);
  assert.equal(shouldAttemptDailyXPost({ xPostedAt: '2026-03-11T03:01:00Z' }), false);
  assert.equal(shouldAttemptDailyXPost({ xPostId: '1234567890' }), false);
});

test('buildNightXPostFailureNotice matches the expected failure post text', () => {
  assert.equal(
    buildNightXPostFailureNotice('dancing_amigo'),
    '今日のボスのサマリー投稿失敗しました... ボス、確認お願いします🙏 @dancing_amigo'
  );
});

test('buildDailyXPostPrompt reads from previous daily log instead of close summary', () => {
  const prompt = buildDailyXPostPrompt({
    dateKey: '2026-03-11',
    localTime: '03:00:00',
    timeZone: 'UTC',
    conversationText: '- 会話履歴なし',
    agendaText: '- 予定なし',
    dailyLogText: '# 2026-03-11\n\n## ノート\n- 進捗あり\n'
  });

  assert.match(prompt, /前日の日次ログ:/);
  assert.doesNotMatch(prompt, /summaryText/);
  assert.doesNotMatch(prompt, /内部サマリー/);
});

test('generateDailyXPostText uses daily log directly and appends mention', async () => {
  let receivedPrompt = '';

  const text = await generateDailyXPostText({
    userId: 'user-1',
    dateKey: '2026-03-11',
    localTime: '03:00:00',
    timeZone: 'UTC'
  }, {
    loadClosedBusinessDayConversationContextImpl: async () => ({
      text: '- [2026-03-11 12:00:00] user: 今日も進めた'
    }),
    createExecutionContextImpl: () => ({
      getCalendarSnapshot: async () => ({ events: [] })
    }),
    readDailyTimelineRecordImpl: async () => '# 2026-03-11\n\n## ノート\n- ボードゲームの作業を進めた\n',
    createTextOutputImpl: async ({ userPrompt }) => {
      receivedPrompt = userPrompt;
      return '今日は着実に前進しました。';
    }
  });

  assert.match(receivedPrompt, /前日の日次ログ:/);
  assert.match(receivedPrompt, /ボードゲームの作業を進めた/);
  assert.equal(text, '今日は着実に前進しました。 @dancing_amigo');
});

test('generateDailyXPostText fails hard when daily log is missing', async () => {
  await assert.rejects(
    generateDailyXPostText({
      userId: 'user-1',
      dateKey: '2026-03-11',
      localTime: '03:00:00',
      timeZone: 'UTC'
    }, {
      loadClosedBusinessDayConversationContextImpl: async () => ({ text: '- 会話履歴なし' }),
      createExecutionContextImpl: () => ({
        getCalendarSnapshot: async () => ({ events: [] })
      }),
      readDailyTimelineRecordImpl: async () => {
        throw new Error('Google Drive file not found: record/timeline/days/2026-03-11.md');
      },
      createTextOutputImpl: async () => {
        throw new Error('should not be called');
      }
    }),
    /record\/timeline\/days\/2026-03-11\.md/
  );
});
