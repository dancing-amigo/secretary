import { config } from '../config.js';
import {
  getNotificationRecord,
  updateNotificationRecord
} from './googleDriveState.js';
import { appendXMention, generateNightXPostText } from './assistantEngine.js';
import { isXPostingEnabled, postTweet, xClientConfigError } from './xClient.js';

export function buildNightXPostFailureNotice(username = config.x.mentionUsername) {
  return appendXMention(
    '今日のボスのサマリー投稿失敗しました... ボス、確認お願いします🙏',
    username
  );
}

function serializeXErrorDetail(error) {
  if (error?.responseBody) {
    try {
      return JSON.stringify(error.responseBody).slice(0, 500);
    } catch {}
  }

  return String(error?.message || error || 'unknown error').slice(0, 500);
}

export function shouldAttemptNightXPost(record) {
  if (!record || typeof record !== 'object') return true;
  return !(
    record.xPostAttemptedAt ||
    record.xPostStatus ||
    record.xPostedAt ||
    record.xPostFailedAt ||
    record.xPostId
  );
}

export async function maybePostNightSummaryToX({ userId, dateKey, localTime, timeZone = config.tz }) {
  if (!isXPostingEnabled()) {
    return { skipped: true, reason: 'x disabled' };
  }

  const configError = xClientConfigError();
  if (configError) {
    return { skipped: true, reason: configError };
  }

  const existing = await getNotificationRecord({ slot: 'night', dateKey });
  if (!shouldAttemptNightXPost(existing)) {
    return { skipped: true, reason: 'already attempted' };
  }

  const attemptedAt = new Date().toISOString();
  await updateNotificationRecord({
    slot: 'night',
    dateKey,
    updates: {
      xPostAttemptedAt: attemptedAt,
      xPostStatus: 'attempting'
    }
  });

  try {
    const text = await generateNightXPostText({ userId, dateKey, localTime, timeZone });
    await updateNotificationRecord({
      slot: 'night',
      dateKey,
      updates: {
        xPostCandidateText: String(text || '').slice(0, 500)
      }
    });
    const result = await postTweet(text);
    const postedAt = new Date().toISOString();
    const tweetId = String(result?.data?.id || '').trim();

    await updateNotificationRecord({
      slot: 'night',
      dateKey,
      updates: {
        xPostStatus: 'posted',
        xPostedAt: postedAt,
        xPostId: tweetId,
        xPostText: String(text || '').slice(0, 500)
      }
    });

    return {
      skipped: false,
      ok: true,
      postedAt,
      tweetId,
      text
    };
  } catch (error) {
    const errorText = String(error?.message || error || 'unknown error');
    const errorDetail = serializeXErrorDetail(error);
    console.error('[x-posting] night post failed', {
      dateKey,
      error: errorText,
      detail: errorDetail
    });

    try {
      const failureNotice = buildNightXPostFailureNotice();
      const failureNoticeResult = await postTweet(failureNotice);
      const postedAt = new Date().toISOString();
      const tweetId = String(failureNoticeResult?.data?.id || '').trim();

      await updateNotificationRecord({
        slot: 'night',
        dateKey,
        updates: {
          xPostStatus: 'posted_failure_notice',
          xPostedAt: postedAt,
          xPostId: tweetId,
          xPostText: failureNotice,
          xPostError: failureNotice.slice(0, 500),
          xPostInternalError: `${errorText} | ${errorDetail}`.slice(0, 500)
        }
      });

      return {
        skipped: false,
        ok: false,
        postedAt,
        tweetId,
        text: failureNotice,
        error: failureNotice
      };
    } catch (fallbackError) {
      const failedAt = new Date().toISOString();
      const fallbackErrorText = String(fallbackError?.message || fallbackError || 'unknown error');
      const failureNotice = buildNightXPostFailureNotice();

      await updateNotificationRecord({
        slot: 'night',
        dateKey,
        updates: {
          xPostStatus: 'failed',
          xPostFailedAt: failedAt,
          xPostError: failureNotice.slice(0, 500),
          xPostInternalError: `${errorText} | ${errorDetail} | failure_notice: ${fallbackErrorText}`.slice(0, 500)
        }
      });

      console.error('[x-posting] failure notice post failed', {
        dateKey,
        error: fallbackErrorText
      });

      return {
        skipped: false,
        ok: false,
        failedAt,
        error: failureNotice
      };
    }
  }
}
