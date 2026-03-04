import { config } from '../config.js';

export async function jsonResponse({ system, user, schemaHint }) {
  if (!config.openai.apiKey) return null;

  const body = {
    model: config.openai.model,
    input: [
      { role: 'system', content: [{ type: 'input_text', text: system }] },
      { role: 'user', content: [{ type: 'input_text', text: user }] }
    ],
    temperature: 0.2,
    text: {
      format: {
        type: 'json_schema',
        name: 'response',
        schema: schemaHint,
        strict: true
      }
    }
  };

  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.openai.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`OpenAI error ${res.status}: ${t}`);
  }

  const data = await res.json();
  const jsonText = data.output_text;
  if (!jsonText) return null;
  return JSON.parse(jsonText);
}

export async function textResponse({ system, user, temperature = 0.7 }) {
  if (!config.openai.apiKey) return null;

  const body = {
    model: config.openai.model,
    input: [
      { role: 'system', content: [{ type: 'input_text', text: system }] },
      { role: 'user', content: [{ type: 'input_text', text: user }] }
    ],
    temperature
  };

  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.openai.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`OpenAI error ${res.status}: ${t}`);
  }

  const data = await res.json();
  return data.output_text || null;
}
