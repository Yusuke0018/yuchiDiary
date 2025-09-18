import { logger } from 'firebase-functions';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import admin from 'firebase-admin';
import OpenAI from 'openai';
import { DateTime, Settings } from 'luxon';

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();

Settings.defaultZone = 'Asia/Tokyo';
Settings.defaultLocale = 'ja-JP';
Settings.defaultWeekSettings = {
  firstDay: 7,
  minimalDaysInFirstWeek: 1,
};

const FIELD_VALUE = admin.firestore.FieldValue;
const ALLOWED_EMAILS = new Set([
  'youyou00181002@gmail.com',
  'REPLACE_WITH_CHII_EMAIL',
]);

const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';

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

function computeSundayWeekNumber(dateTime) {
  const startOfYear = DateTime.fromObject(
    { year: dateTime.year, month: 1, day: 1 },
    { zone: 'Asia/Tokyo' }
  );
  const startOfYearWeekday = startOfYear.weekday % 7;
  const diffInDays = Math.floor(
    dateTime.startOf('day').diff(startOfYear.startOf('day'), 'days').days
  );
  const weekIndex = Math.floor((diffInDays + startOfYearWeekday) / 7) + 1;
  return weekIndex;
}

function buildWeekKey(dateTime) {
  const weekNumber = computeSundayWeekNumber(dateTime);
  return `${dateTime.year}-W${String(weekNumber).padStart(2, '0')}`;
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
    entriesSnap.forEach((docSnap) => {
      const data = docSnap.data();
      if (typeof data.score === 'number') {
        scoreSum += data.score;
        scoreCount += 1;
      }
    });
    const scoreAverage = scoreCount ? scoreSum / scoreCount : null;
    await dayRef.set(
      {
        scoreSum,
        scoreCount,
        scoreAverage,
        lastAggregateAt: FIELD_VALUE.serverTimestamp(),
      },
      { merge: true }
    );
    logger.debug('Aggregates synced', { dayId, scoreSum, scoreCount });
  }
);

export const generateWeeklyComment = onSchedule(
  {
    schedule: '0 0 * * 0',
    timeZone: 'Asia/Tokyo',
    region: 'asia-northeast1',
  },
  async () => {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      logger.warn(
        'OPENAI_API_KEY が設定されていないため週次コメント生成をスキップしました。'
      );
      return;
    }
    const client = new OpenAI({ apiKey });
    const now = DateTime.now().setZone('Asia/Tokyo');
    const targetDay = now.minus({ days: 1 });
    const weekStart = targetDay.startOf('week');
    const weekEnd = targetDay.endOf('week');
    const weekKey = buildWeekKey(targetDay);
    const weeklyRef = db.collection('weeklyComments').doc(weekKey);
    const existing = await weeklyRef.get();
    if (existing.exists && existing.data()?.text) {
      logger.info('週次コメントは既に存在します', { weekKey });
      return;
    }
    const dayKeys = Array.from({ length: 7 }, (_, index) =>
      weekStart.plus({ days: index }).toFormat('yyyy-LL-dd')
    );
    const dayDocs = await Promise.all(
      dayKeys.map(async (key) => {
        const snap = await db.collection('days').doc(key).get();
        if (!snap.exists) {
          return null;
        }
        const dayData = snap.data();
        const entriesSnap = await snap.ref
          .collection('entries')
          .orderBy('role')
          .get();
        const entries = entriesSnap.docs.map((docSnap) => ({
          id: docSnap.id,
          ...docSnap.data(),
        }));
        return {
          key,
          data: dayData,
          entries,
        };
      })
    );
    const validDays = dayDocs.filter(Boolean);
    if (!validDays.length) {
      logger.info('対象週にデータが無いためコメント生成をスキップしました', {
        weekKey,
      });
      return;
    }
    const stats = aggregateWeek(validDays);
    const previousStats = await collectPreviousWeekStats(weekStart, 3);
    const prompt = buildWeeklyPrompt({
      weekKey,
      weekStart,
      weekEnd,
      stats,
      days: validDays,
      previousStats,
    });
    logger.debug('Prompt for weekly comment created', {
      weekKey,
      promptLength: prompt.length,
    });
    const completion = await client.responses.create({
      model: DEFAULT_MODEL,
      input: [
        {
          role: 'system',
          content:
            'あなたは温かい視点を持つ日本語のライフコーチです。否定や断定的な言い方を避け、夫婦のがんばりを肯定して励まします。',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
    });
    const text = completion.output_text?.trim?.() || '';
    const finalText = enforceLength(text, 400, 520);
    await weeklyRef.set(
      {
        text: finalText,
        generatedAt: FIELD_VALUE.serverTimestamp(),
        weekKey,
        timeframe: {
          start: weekStart.toISODate(),
          end: weekEnd.toISODate(),
        },
        stats,
        references: previousStats,
      },
      { merge: true }
    );
    logger.info('週次コメントを生成しました', { weekKey });
  }
);

function aggregateWeek(days) {
  const aggregated = days.reduce(
    (acc, day) => {
      const { data, entries } = day;
      acc.scoreSum += data.scoreSum || 0;
      acc.scoreCount += data.scoreCount || 0;
      acc.thanksTotal += data.thanksTotal || 0;
      const breakdown = data.thanksBreakdown || {};
      acc.thanks.master += breakdown.master || 0;
      acc.thanks.chii += breakdown.chii || 0;
      acc.entries.push(
        ...entries.map((entry) => ({
          role: entry.role,
          score: entry.score,
          note: entry.note || '',
          dayKey: day.key,
        }))
      );
      acc.days.push({
        key: day.key,
        display: data.displayDate || day.key,
        scoreSum: data.scoreSum || 0,
        scoreCount: data.scoreCount || 0,
        thanksTotal: data.thanksTotal || 0,
        breakdown: data.thanksBreakdown || {},
      });
      return acc;
    },
    {
      scoreSum: 0,
      scoreCount: 0,
      thanksTotal: 0,
      thanks: { master: 0, chii: 0 },
      entries: [],
      days: [],
    }
  );
  aggregated.scoreAverage = aggregated.scoreCount
    ? aggregated.scoreSum / aggregated.scoreCount
    : null;
  return aggregated;
}

async function collectPreviousWeekStats(weekStart, count) {
  const stats = [];
  for (let i = 1; i <= count; i += 1) {
    const targetStart = weekStart.minus({ weeks: i });
    const dayKeys = Array.from({ length: 7 }, (_, index) =>
      targetStart.plus({ days: index }).toFormat('yyyy-LL-dd')
    );
    let scoreSum = 0;
    let scoreCount = 0;
    let thanksTotal = 0;
    for (const key of dayKeys) {
      const daySnap = await db.collection('days').doc(key).get();
      if (!daySnap.exists) continue;
      const data = daySnap.data();
      scoreSum += data.scoreSum || 0;
      scoreCount += data.scoreCount || 0;
      thanksTotal += data.thanksTotal || 0;
    }
    if (scoreCount === 0 && thanksTotal === 0) continue;
    stats.push({
      weekKey: buildWeekKey(targetStart),
      scoreAverage: scoreCount ? scoreSum / scoreCount : null,
      thanksTotal,
    });
  }
  return stats;
}

function buildWeeklyPrompt({
  weekKey,
  weekStart,
  weekEnd,
  stats,
  days,
  previousStats,
}) {
  const average = stats.scoreCount
    ? (stats.scoreSum / stats.scoreCount).toFixed(2)
    : '記録なし';
  const lines = [];
  lines.push(
    `対象週: ${weekKey} (${weekStart.toFormat('M月d日')}〜${weekEnd.toFormat('M月d日')})`
  );
  lines.push(`平均スコア: ${average}`);
  lines.push(
    `ありがとう合計: ${stats.thanksTotal} (祐介:${stats.thanks.master}, 千里:${stats.thanks.chii})`
  );
  if (previousStats.length) {
    lines.push('過去週の平均:');
    previousStats.forEach((item) => {
      lines.push(
        `- ${item.weekKey}: スコア${item.scoreAverage?.toFixed?.(2) ?? '記録なし'}, ありがとう${item.thanksTotal}`
      );
    });
  }
  lines.push('日別のトピック:');
  days.forEach((day) => {
    const avg = day.scoreCount
      ? (day.scoreSum / day.scoreCount).toFixed(2)
      : '記録なし';
    lines.push(`- ${day.display}: 平均${avg}, ありがとう${day.thanksTotal}`);
    const related = stats.entries.filter((entry) => entry.dayKey === day.key);
    related.forEach((entry) => {
      const name = entry.role === 'master' ? '祐介' : '千里';
      const note = truncate(entry.note, 120);
      lines.push(`  ・${name}: 評価${entry.score} / ${note || 'メモなし'}`);
    });
  });
  lines.push(
    '上記をふまえて、お二人への温かい応援コメントを約400文字で作成してください。' +
      '励ましと感謝を中心にし、改善提案は多くても2点、柔らかい表現で伝えてください。'
  );
  return lines.join('\n');
}

function truncate(text, max) {
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function enforceLength(text, targetLength, maxLength) {
  if (!text) return '';
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}…`;
}
