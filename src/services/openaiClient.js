import axios from 'axios';
import { config } from '../config.js';
import { readSoulMarkdown, readUserMarkdown } from './googleDriveState.js';

const chatApi = axios.create({
  baseURL: config.openai.baseUrl,
  timeout: config.openai.timeoutMs
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

  if (isTimeoutError(error)) {
    return new Error('応答生成に時間がかかりすぎました。少し置いてからもう一度送ってください。');
  }

  return error instanceof Error ? error : new Error(String(error || 'Unknown API error'));
}

function isTimeoutError(error) {
  return error?.code === 'ECONNABORTED' || /timeout/i.test(String(error?.message || ''));
}

function isRetryableApiError(error) {
  const status = Number(error?.response?.status || 0);
  return isTimeoutError(error) || status === 429 || status >= 500;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postChatCompletion(body, attempt = 0) {
  try {
    return await chatApi.post('/chat/completions', body, {
      headers: {
        Authorization: `Bearer ${config.openai.apiKey}`,
        'Content-Type': 'application/json'
      }
    });
  } catch (error) {
    if (attempt >= 1 || !isRetryableApiError(error)) {
      throw error;
    }

    await wait(800);
    return postChatCompletion(body, attempt + 1);
  }
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
    const response = await postChatCompletion({
      model,
      messages: [
        { role: 'system', content: injectedSystemPrompt },
        { role: 'user', content: userPrompt }
      ]
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
    const response = await postChatCompletion({
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
    });

    return JSON.parse(extractStructuredContent(response));
  } catch (error) {
    throw toReadableApiError(error);
  }
}
