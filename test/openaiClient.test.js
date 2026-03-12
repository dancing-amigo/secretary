import test from 'node:test';
import assert from 'node:assert/strict';

import { buildInjectedSystemPrompt } from '../src/services/openaiClient.js';

test('buildInjectedSystemPrompt allows explicit profile context overrides', async () => {
  const prompt = await buildInjectedSystemPrompt('system instruction', {
    profileContext: {
      scope: 'owner_readonly',
      soulMarkdown: '# SOUL override',
      userMarkdown: '# USER override'
    }
  });

  assert.match(prompt, /\[SOUL\.md\]\n# SOUL override/);
  assert.match(prompt, /\[USER\.md\]\n# USER override/);
  assert.match(prompt, /\[SYSTEM INSTRUCTION\]\nsystem instruction/);
});
