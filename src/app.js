import express from 'express';
import { config } from './config.js';
import { verifyLineSignature, replyMessage, pushMessage } from './services/lineClient.js';
import { processUserMessage, runMorningPlan, runNightReview } from './services/assistantEngine.js';
import { runReminderTick } from './services/scheduler.js';
import { withDriveSync, driveStatus, driveDebugSnapshot } from './services/driveSync.js';

export const app = express();

app.get('/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.post('/webhook/line', express.raw({ type: '*/*' }), async (req, res) => {
  const rawBody = req.body?.toString('utf8') || '';
  const signature = req.headers['x-line-signature'];
  let parsedForDebug = null;
  try {
    parsedForDebug = JSON.parse(rawBody);
  } catch {
    parsedForDebug = null;
  }

  if (!verifyLineSignature(rawBody, String(signature || ''))) {
    // eslint-disable-next-line no-console
    console.error(
      '[line-signature-invalid]',
      JSON.stringify({
        hasSignature: Boolean(signature),
        firstUserId: parsedForDebug?.events?.[0]?.source?.userId || null,
        eventCount: parsedForDebug?.events?.length || 0
      })
    );
    return res.status(401).send('invalid signature');
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return res.status(400).send('invalid json');
  }

  await withDriveSync(async () => {
    const events = payload.events || [];
    for (const event of events) {
      if (event.type !== 'message' || event.message?.type !== 'text') continue;
      const userId = event.source?.userId || config.line.defaultUserId;
      if (!userId) continue;

      const text = event.message.text || '';
      // Runtime log for initial LINE user binding/debug.
      // eslint-disable-next-line no-console
      console.log('[line-event]', JSON.stringify({ userId, text, eventType: event.type }));
      try {
        const replyText = await processUserMessage({ userId, text });
        try {
          await replyMessage(event.replyToken, replyText);
        } catch (replyErr) {
          // eslint-disable-next-line no-console
          console.error('[line-reply-failed-fallback-to-push]', String(replyErr.message || replyErr));
          try {
            await pushMessage(userId, replyText);
          } catch (pushErr) {
            // eslint-disable-next-line no-console
            console.error('[line-push-failed]', String(pushErr.message || pushErr));
          }
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[line-reply-error]', String(e.message || e));
        const errText = `処理中にエラーが発生しました: ${String(e.message || e)}`;
        try {
          await replyMessage(event.replyToken, errText);
        } catch (replyErr) {
          // eslint-disable-next-line no-console
          console.error('[line-error-reply-failed-fallback-to-push]', String(replyErr.message || replyErr));
          try {
            await pushMessage(userId, errText);
          } catch (pushErr) {
            // eslint-disable-next-line no-console
            console.error('[line-error-push-failed]', String(pushErr.message || pushErr));
          }
        }
      }
    }
  });

  return res.status(200).send('ok');
});

app.post('/internal/morning', express.json(), async (_req, res) => {
  try {
    const targetUser = config.line.defaultUserId;
    if (!targetUser) return res.status(400).json({ ok: false, error: 'LINE_DEFAULT_USER_ID is required' });
    await withDriveSync(async () => {
      const text = await runMorningPlan(targetUser);
      await pushMessage(targetUser, text);
    });
    res.json({ ok: true, sent: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post('/internal/night', express.json(), async (_req, res) => {
  try {
    const targetUser = config.line.defaultUserId;
    if (!targetUser) return res.status(400).json({ ok: false, error: 'LINE_DEFAULT_USER_ID is required' });
    await withDriveSync(async () => {
      const text = runNightReview(targetUser);
      await pushMessage(targetUser, text);
    });
    res.json({ ok: true, sent: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post('/internal/reminder-tick', express.json(), async (_req, res) => {
  try {
    const out = await withDriveSync(async () => runReminderTick());
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post('/internal/chat', express.json(), async (req, res) => {
  const userId = req.body?.userId || config.line.defaultUserId || 'U_local';
  const text = req.body?.text || '';
  if (!text) return res.status(400).json({ ok: false, error: 'text is required' });
  try {
    const reply = await withDriveSync(async () => processUserMessage({ userId, text }));
    res.json({ ok: true, reply });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get('/internal/drive-status', (_req, res) => {
  res.json({ ok: true, drive: driveStatus() });
});

app.get('/internal/drive-debug', async (_req, res) => {
  try {
    const data = await driveDebugSnapshot();
    res.json({ ok: true, drive: data });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

export default app;
