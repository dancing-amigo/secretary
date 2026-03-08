import axios from 'axios';
import { config } from '../config.js';
import { readSoulMarkdown, readUserMarkdown } from './googleDriveState.js';

const chatApi = axios.create({
  baseURL: config.openai.baseUrl,
  timeout: 30000
});

function llmConfigError() {
  if (!config.openai.apiKey) return 'OPENAI_API_KEY is required';
  return '';
}

function toReadableApiError(error) {
  const apiMessage = error?.response?.data?.error?.message;
  if (apiMessage) {
    return new Error(String(apiMessage));
  }

  return error instanceof Error ? error : new Error(String(error || 'Unknown API error'));
}

function extractStructuredContent(response) {
  const choice = response.data?.choices?.[0]?.message;
  if (choice?.refusal) {
    throw new Error(`LLM refusal: ${choice.refusal}`);
  }

  const content = choice?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('LLM returned empty content');
  }

  return content;
}

async function buildInjectedSystemPrompt(systemPrompt) {
  const [soulMarkdown, userMarkdown] = await Promise.all([
    readSoulMarkdown(),
    readUserMarkdown()
  ]);

  return [
    '以下の順序で与える固定コンテキストを、以後の全応答で必ず優先して参照してください。',
    '',
    '[SOUL.md]',
    String(soulMarkdown || '').trim(),
    '',
    '[USER.md]',
    String(userMarkdown || '').trim(),
    '',
    '[SYSTEM INSTRUCTION]',
    String(systemPrompt || '').trim()
  ].join('\n');
}

export async function createTextOutput({ model, systemPrompt, userPrompt }) {
  const configError = llmConfigError();
  if (configError) {
    throw new Error(configError);
  }

  try {
    const injectedSystemPrompt = await buildInjectedSystemPrompt(systemPrompt);
    const response = await chatApi.post('/chat/completions', {
      model,
      messages: [
        { role: 'system', content: injectedSystemPrompt },
        { role: 'user', content: userPrompt }
      ]
    }, {
      headers: {
        Authorization: `Bearer ${config.openai.apiKey}`,
        'Content-Type': 'application/json'
      }
    });

    return extractStructuredContent(response);
  } catch (error) {
    throw toReadableApiError(error);
  }
}

export async function createStructuredOutput({ model, schemaName, schema, systemPrompt, userPrompt }) {
  const configError = llmConfigError();
  if (configError) {
    throw new Error(configError);
  }

  try {
    const injectedSystemPrompt = await buildInjectedSystemPrompt(systemPrompt);
    const response = await chatApi.post('/chat/completions', {
      model,
      messages: [
        { role: 'system', content: injectedSystemPrompt },
        { role: 'user', content: userPrompt }
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: schemaName,
          strict: true,
          schema
        }
      }
    }, {
      headers: {
        Authorization: `Bearer ${config.openai.apiKey}`,
        'Content-Type': 'application/json'
      }
    });

    return JSON.parse(extractStructuredContent(response));
  } catch (error) {
    throw toReadableApiError(error);
  }
}
