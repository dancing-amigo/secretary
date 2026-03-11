import test from 'node:test';
import assert from 'node:assert/strict';

import {
  appendXMention,
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
