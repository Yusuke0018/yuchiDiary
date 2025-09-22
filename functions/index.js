import { logger } from 'firebase-functions';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import admin from 'firebase-admin';

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();

const FIELD_VALUE = admin.firestore.FieldValue;
const ALLOWED_EMAILS = new Set([
  'youyou00181002@gmail.com',
  'tanachi1102@gmail.com',
]);

function ensureAllowed(auth) {
  if (!auth) {
    throw new HttpsError('unauthenticated', '認証が必要です。');
  }
  const email = auth.token?.email;
  if (!email || !ALLOWED_EMAILS.has(email)) {
    throw new HttpsError(
      'permission-denied',
      '許可されたアカウントではありません。'
    );
  }
  return email;
}

async function fetchUserProfile(uid) {
  const userSnap = await db.collection('users').doc(uid).get();
  if (!userSnap.exists) {
    throw new HttpsError(
      'permission-denied',
      'ユーザープロファイルが登録されていません。'
    );
  }
  return userSnap.data();
}

export const incrementThanks = onCall(
  { region: 'asia-northeast1' },
  async (request) => {
    const { data, auth } = request;
    ensureAllowed(auth);
    const profile = await fetchUserProfile(auth.uid);
    if (!['master', 'chii'].includes(profile.role)) {
      throw new HttpsError('permission-denied', '無効なロールです。');
    }
    const { dayKey } = data || {};
    if (!dayKey || typeof dayKey !== 'string') {
      throw new HttpsError('invalid-argument', 'dayKey が必要です。');
    }
    const dayRef = db.collection('days').doc(dayKey);
    await db.runTransaction(async (transaction) => {
      const daySnap = await transaction.get(dayRef);
      if (!daySnap.exists) {
        throw new HttpsError('not-found', '該当するスレッドが存在しません。');
      }
      transaction.update(dayRef, {
        [`thanksBreakdown.${profile.role}`]: FIELD_VALUE.increment(1),
        thanksTotal: FIELD_VALUE.increment(1),
        updatedAt: FIELD_VALUE.serverTimestamp(),
      });
    });
    logger.info('Thanks incremented', { dayKey, uid: auth.uid });
    return { ok: true };
  }
);

export const syncDayAggregates = onDocumentWritten(
  {
    document: 'days/{dayId}/entries/{entryId}',
    region: 'asia-northeast1',
  },
  async (event) => {
    const dayId = event.params.dayId;
    const dayRef = db.collection('days').doc(dayId);
    const entriesSnap = await dayRef.collection('entries').get();
    let scoreSum = 0;
    let scoreCount = 0;
    const roleScore = {
      master: { scoreSum: 0, scoreCount: 0 },
      chii: { scoreSum: 0, scoreCount: 0 },
    };
    entriesSnap.forEach((docSnap) => {
      const data = docSnap.data();
      if (typeof data.score === 'number') {
        scoreSum += data.score;
        scoreCount += 1;
        const role = data.role;
        if (role === 'master' || role === 'chii') {
          roleScore[role].scoreSum += data.score;
          roleScore[role].scoreCount += 1;
        }
      }
    });
    const scoreAverage = scoreCount ? scoreSum / scoreCount : null;
    const scoreBreakdown = {
      master: {
        sum: roleScore.master.scoreSum,
        count: roleScore.master.scoreCount,
        average: roleScore.master.scoreCount
          ? roleScore.master.scoreSum / roleScore.master.scoreCount
          : null,
      },
      chii: {
        sum: roleScore.chii.scoreSum,
        count: roleScore.chii.scoreCount,
        average: roleScore.chii.scoreCount
          ? roleScore.chii.scoreSum / roleScore.chii.scoreCount
          : null,
      },
    };
    await dayRef.set(
      {
        scoreSum,
        scoreCount,
        scoreAverage,
        scoreBreakdown,
        lastAggregateAt: FIELD_VALUE.serverTimestamp(),
      },
      { merge: true }
    );
    logger.debug('Aggregates synced', { dayId, scoreSum, scoreCount });
  }
);

// 週次AIコメント機能は運用方針により一時的に停止中です。
