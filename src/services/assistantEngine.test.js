import test from 'node:test';
import assert from 'node:assert/strict';
import { getUtcIsoForLocalDateTime } from './assistantEngine.js';

test('getUtcIsoForLocalDateTime accepts HH:MM local times', () => {
  const iso = getUtcIsoForLocalDateTime({
    dateKey: '2026-03-07',
    time: '22:00',
    timeZone: 'America/Vancouver'
  });

  assert.equal(iso, '2026-03-08T06:00:00.000Z');
});

test('getUtcIsoForLocalDateTime accepts HH:MM:SS local times', () => {
  const iso = getUtcIsoForLocalDateTime({
    dateKey: '2026-03-07',
    time: '22:00:15',
    timeZone: 'America/Vancouver'
  });

  assert.equal(iso, '2026-03-08T06:00:15.000Z');
});
