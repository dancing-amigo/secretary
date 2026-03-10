import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildReminderBaseMessage,
  normalizeReminderMessage
} from '../src/services/eventReminders.js';

test('buildReminderBaseMessage returns fixed start reminder text', () => {
  const text = buildReminderBaseMessage({ title: '会議' }, 'start');
  assert.equal(text, '「会議」の時間です。');
});

test('buildReminderBaseMessage returns fixed end reminder text', () => {
  const text = buildReminderBaseMessage({ title: '会議' }, 'end');
  assert.equal(text, '「会議」は終了時刻です。まだ終わっていなければ対応してください。');
});

test('normalizeReminderMessage falls back when model output is empty', () => {
  const fallback = '「会議」の時間です。';
  assert.equal(normalizeReminderMessage('', fallback), fallback);
  assert.equal(normalizeReminderMessage('   ', fallback), fallback);
});

test('normalizeReminderMessage trims and preserves generated content', () => {
  const fallback = '「会議」の時間です。';
  const output = normalizeReminderMessage('\n「会議」の時間です。必要なら資料を見返してください。\n', fallback);
  assert.equal(output, '「会議」の時間です。必要なら資料を見返してください。');
});
