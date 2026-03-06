import axios from 'axios';
import { config } from '../config.js';

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

export async function createStructuredOutput({ model, schemaName, schema, systemPrompt, userPrompt }) {
  const configError = llmConfigError();
  if (configError) {
    throw new Error(configError);
  }

  try {
    const response = await chatApi.post('/chat/completions', {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
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
