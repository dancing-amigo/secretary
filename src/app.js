import express from 'express';
import { requireCronAuth } from '../api/_lib/cronAuth.js';
import { appendConversationTurn } from './services/googleDriveState.js';
import { runEventReminderDelivery } from './services/eventReminders.js';
import { verifyLineSignature, replyMessage } from './services/lineClient.js';
import { processUserMessage } from './services/assistantEngine.js';

export const app = express();

app.get('/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.post('/webhook/line', express.raw({ type: '*/*' }), async (req, res) => {
  const rawBody = req.body?.toString('utf8') || '';
  const signature = req.headers['x-line-signature'];

  if (!verifyLineSignature(rawBody, String(signature || ''))) {
    return res.status(401).send('invalid signature');
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return res.status(400).send('invalid json');
  }

  const events = payload.events || [];
  for (const event of events) {
    if (event.type !== 'message' || event.message?.type !== 'text') continue;
    const userId = event.source?.userId || '';
    const userText = event.message.text || '';

    try {
      await appendConversationTurn({ userId, role: 'user', text: userText });

      const replyText = await processUserMessage({ userId, text: userText });
      await replyMessage(event.replyToken, replyText);
      try {
        await appendConversationTurn({ userId, role: 'assistant', text: replyText });
      } catch {}
    } catch (e) {
      const errText = String(e.message || e || 'error');
      await replyMessage(event.replyToken, errText);
      try {
        await appendConversationTurn({ userId, role: 'assistant', text: errText });
      } catch {}
    }
  }

  return res.status(200).send('ok');
});

app.post('/api/jobs/event-reminder-delivery', express.json({ type: '*/*' }), async (req, res) => {
  if (!requireCronAuth(req, res)) return;
  const out = await runEventReminderDelivery(req.body);
  res.status(200).json({ ok: true, ...out });
});

export default app;
