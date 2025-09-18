import { firebaseConfig } from '../firebase-config.js';
import { APP_USERS, APP_SETTINGS } from '../app-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.13.1/firebase-app.js';
import {
  browserLocalPersistence,
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  setPersistence,
  signInWithPopup,
  signOut,
} from 'https://www.gstatic.com/firebasejs/10.13.1/firebase-auth.js';
import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  startAfter,
  Timestamp,
  updateDoc,
  where,
} from 'https://www.gstatic.com/firebasejs/10.13.1/firebase-firestore.js';
import {
  getFunctions,
  httpsCallable,
} from 'https://www.gstatic.com/firebasejs/10.13.1/firebase-functions.js';

const { DateTime, Settings } = luxon;

Settings.defaultLocale = 'ja-JP';
Settings.defaultZone = APP_SETTINGS.timezone;

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);
const functions = getFunctions(firebaseApp, 'asia-northeast1');
const incrementThanksCallable = httpsCallable(functions, 'incrementThanks');

const userIndex = new Map(APP_USERS.map((user) => [user.email, user]));
const roleLabels = APP_USERS.reduce((acc, user) => {
  acc[user.role] = user.displayName;
  return acc;
}, {});

const state = {
  authUser: null,
  profile: null,
  activeDayKey: null,
  todayKey: null,
  isLateNight: false,
  agreements: [],
  showAllAgreements: false,
  historyCursor: null,
  historyHasMore: true,
  historyBatch: APP_SETTINGS.ui?.maxHistoryBatch || 14,
  chart: null,
};

const unsubscribers = {
  agreements: null,
  day: null,
  entries: null,
  weeklyComments: null,
};

const dom = {
  loginButton: document.getElementById('login-button'),
  logoutButton: document.getElementById('logout-button'),
  userPanel: document.getElementById('user-panel'),
  userName: document.getElementById('user-name'),
  signedOut: document.getElementById('signed-out'),
  main: document.getElementById('main-content'),
  agreementList: document.getElementById('agreement-list'),
  agreementEmpty: document.getElementById('agreement-empty'),
  toggleAgreementView: document.getElementById('toggle-agreement-view'),
  addAgreement: document.getElementById('add-agreement'),
  modalBackdrop: document.getElementById('modal-backdrop'),
  modalTitle: document.getElementById('modal-title'),
  modalForm: document.getElementById('modal-form'),
  modalCancel: document.getElementById('modal-cancel'),
  dayTitle: document.getElementById('day-title'),
  dayMeta: document.getElementById('day-meta'),
  entryMaster: document.getElementById('entry-master'),
  entryChii: document.getElementById('entry-chii'),
  thanksTotal: document.getElementById('thanks-total'),
  thanksMaster: document.getElementById('thanks-master'),
  thanksChii: document.getElementById('thanks-chii'),
  thanksButton: document.getElementById('thanks-button'),
  historyList: document.getElementById('history-list'),
  historyLoadMore: document.getElementById('load-more-history'),
  jumpToday: document.getElementById('jump-today'),
  statTodayScore: document.getElementById('stat-today-score'),
  statTodayThanks: document.getElementById('stat-today-thanks'),
  statWeekScore: document.getElementById('stat-week-score'),
  statWeekThanks: document.getElementById('stat-week-thanks'),
  statMonthScore: document.getElementById('stat-month-score'),
  statMonthThanks: document.getElementById('stat-month-thanks'),
  trendCanvas: document.getElementById('trend-chart'),
  weeklyCurrent: document.getElementById('weekly-comment-current'),
  weeklyHistory: document.getElementById('weekly-comment-history'),
  toast: document.getElementById('toast'),
};

const AGREEMENT_ACTIONS = {
  EDIT: 'edit',
  TOGGLE_PIN: 'toggle-pin',
  ARCHIVE: 'archive',
};

const DEFAULT_AGREEMENTS = [
  '朝のハグ',
  '６時50分には起きる（しんどい時は申告する）',
  '子供たちとの時間の時は携帯を渡す。使いたい時は貸してもらう。',
  '週に１回日曜日に評価、振り返り',
  '休みの日に仕事をしたい時は事前に申告する。時間も。',
  '汚い言葉を使わない（特にちいちゃん）',
  '頼まれたら１０秒以内に動く。うだうだ言わない。',
  '怒ってても無視しない。聞かれたら答える',
  '毎日携帯を完全において夫婦の時間を３０分作る',
];

const SCORE_OPTIONS = [
  { value: 4, label: '良い' },
  { value: 3, label: 'ちょっといい' },
  { value: 2, label: 'ちょっと悪い' },
  { value: 1, label: '悪い' },
];

const MODAL_MODE = {
  CREATE: 'create',
  EDIT: 'edit',
};

let modalMode = MODAL_MODE.CREATE;
let editingAgreementId = null;
let agreementsSeeded = false;

function showToast(message, duration = 2800) {
  dom.toast.textContent = message;
  dom.toast.classList.add('toast--visible');
  window.setTimeout(() => {
    dom.toast.classList.remove('toast--visible');
  }, duration);
}

function toggleModal(visible) {
  dom.modalBackdrop.classList.toggle('hidden', !visible);
  if (!visible) {
    dom.modalForm.reset();
    editingAgreementId = null;
  }
}

function getDateInfo(date = DateTime.now(), { respectCutoff = true } = {}) {
  let current = date.setZone(APP_SETTINGS.timezone, { keepLocalTime: false });
  let isLateNight = false;
  if (respectCutoff && current.hour < APP_SETTINGS.lateNightCutoffHour) {
    current = current.minus({ days: 1 });
    isLateNight = true;
  }
  const dayKey = current.toFormat('yyyy-LL-dd');
  const displayDate = `${current.toFormat('yyyy年M月d日(ccc)')}`;
  const weekNumber = computeSundayWeekNumber(current);
  const weekKey = `${current.year}-W${String(weekNumber).padStart(2, '0')}`;
  return { current, dayKey, displayDate, weekKey, isLateNight };
}

function computeSundayWeekNumber(dateTime) {
  const startOfYear = DateTime.fromObject(
    { year: dateTime.year, month: 1, day: 1 },
    { zone: APP_SETTINGS.timezone }
  );
  const startOfYearWeekday = startOfYear.weekday % 7; // Sunday => 0
  const diffInDays = Math.floor(
    dateTime.startOf('day').diff(startOfYear.startOf('day'), 'days').days
  );
  const weekIndex = Math.floor((diffInDays + startOfYearWeekday) / 7) + 1;
  return weekIndex;
}

function getUserMetaByEmail(email) {
  return userIndex.get(email) || null;
}

function handleAuthState(user) {
  state.authUser = user;
  if (user) {
    const info = getUserMetaByEmail(user.email || '');
    if (!info) {
      showToast('許可されたユーザーではありません。');
      signOut(auth);
      return;
    }
    state.profile = {
      ...info,
      uid: user.uid,
      email: user.email,
      photoURL: user.photoURL,
    };
    dom.userPanel.classList.remove('hidden');
    dom.userName.textContent = `${info.displayName}`;
    dom.loginButton.classList.add('hidden');
    dom.signedOut.classList.add('hidden');
    dom.main.classList.remove('hidden');
    initializeAppData().catch((error) => {
      console.error(error);
      showToast('初期化中にエラーが発生しました');
    });
  } else {
    cleanupSubscriptions();
    state.profile = null;
    state.activeDayKey = null;
    state.todayKey = null;
    dom.userPanel.classList.add('hidden');
    dom.loginButton.classList.remove('hidden');
    dom.main.classList.add('hidden');
    dom.signedOut.classList.remove('hidden');
    dom.historyList.innerHTML = '';
    dom.agreementList.innerHTML = '';
    dom.weeklyCurrent.innerHTML = '';
    dom.weeklyHistory.innerHTML = '';
    if (state.chart) {
      state.chart.destroy();
      state.chart = null;
    }
  }
}

function cleanupSubscriptions() {
  Object.keys(unsubscribers).forEach((key) => {
    if (typeof unsubscribers[key] === 'function') {
      unsubscribers[key]();
      unsubscribers[key] = null;
    }
  });
}

async function initializeAppData() {
  await ensureUserProfile();
  const { dayKey, isLateNight } = getDateInfo();
  state.todayKey = dayKey;
  state.isLateNight = isLateNight;
  await setActiveDay(dayKey);
  subscribeAgreements();
  await loadHistory(true);
  subscribeWeeklyComments();
}

async function ensureUserProfile() {
  if (!state.profile) return;
  const userRef = doc(db, 'users', state.profile.uid);
  const snapshot = await getDoc(userRef);
  if (!snapshot.exists()) {
    await setDoc(userRef, {
      displayName: state.profile.displayName,
      email: state.profile.email,
      role: state.profile.role,
      tz: APP_SETTINGS.timezone,
      createdAt: serverTimestamp(),
    });
  } else {
    const data = snapshot.data();
    if (data.role !== state.profile.role) {
      await updateDoc(userRef, {
        role: state.profile.role,
        displayName: state.profile.displayName,
      });
    }
  }
}

function subscribeAgreements() {
  if (unsubscribers.agreements) {
    unsubscribers.agreements();
    unsubscribers.agreements = null;
  }
  const agreementsQuery = query(
    collection(db, 'agreements'),
    where('status', '==', 'active'),
    orderBy('pinned', 'desc'),
    orderBy('order', 'asc')
  );
  unsubscribers.agreements = onSnapshot(agreementsQuery, (snapshot) => {
    if (!snapshot.size && !agreementsSeeded) {
      seedDefaultAgreements().catch((error) => {
        agreementsSeeded = false;
        console.error('Failed to seed agreements', error);
      });
    }
    state.agreements = snapshot.docs.map((docSnap) => ({
      id: docSnap.id,
      ...docSnap.data(),
    }));
    renderAgreementList();
  });
}

async function seedDefaultAgreements() {
  if (!state.profile) return;
  agreementsSeeded = true;
  try {
    let createdCount = 0;
    await Promise.all(
      DEFAULT_AGREEMENTS.map(async (title, index) => {
        const docRef = doc(db, 'agreements', `seed-${index}`);
        const existing = await getDoc(docRef);
        if (existing.exists()) return;
        await setDoc(docRef, {
          title,
          body: '',
          pinned: index === 0,
          order: (index + 1) * 100,
          status: 'active',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
          createdBy: state.profile.uid,
          updatedBy: state.profile.uid,
        });
        createdCount += 1;
      })
    );
    if (createdCount > 0) {
      showToast('夫婦の決め事を初期登録しました');
    }
  } catch (error) {
    agreementsSeeded = false;
    throw error;
  }
}

function renderAgreementList() {
  const items = state.agreements || [];
  dom.toggleAgreementView.textContent = state.showAllAgreements
    ? '先頭のみ表示'
    : 'すべて表示';
  dom.agreementList.innerHTML = '';
  if (!items.length) {
    dom.agreementEmpty.classList.remove('hidden');
    return;
  }
  dom.agreementEmpty.classList.add('hidden');
  items.forEach((item, index) => {
    const li = document.createElement('li');
    li.className = 'agreement-item';
    li.dataset.id = item.id;
    li.draggable = true;
    if (item.pinned) {
      li.classList.add('agreement-item--pinned');
    }
    if (!state.showAllAgreements && index > 0) {
      li.classList.add('agreement-item--collapsed');
    }
    const metaLabel = item.pinned
      ? 'ピン留め中'
      : `更新 ${formatDate(item.updatedAt)}`;
    li.innerHTML = `
      <div class="agreement-item__meta">
        <span>${metaLabel}</span>
      </div>
      <h3 class="agreement-item__title">${escapeHtml(item.title)}</h3>
      <p class="agreement-item__body">${escapeHtml(item.body)}</p>
      <div class="agreement-item__actions">
        <button type="button" class="button button--ghost" data-action="${AGREEMENT_ACTIONS.EDIT}">編集</button>
        <button type="button" class="button button--ghost" data-action="${AGREEMENT_ACTIONS.TOGGLE_PIN}">
          ${item.pinned ? 'ピン解除' : 'ピン留め'}
        </button>
        <button type="button" class="button button--ghost" data-action="${AGREEMENT_ACTIONS.ARCHIVE}">アーカイブ</button>
      </div>
    `;
    dom.agreementList.appendChild(li);
  });
}

function escapeHtml(text = '') {
  return text
    .toString()
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatDate(value) {
  if (!value) return '';
  let dt;
  if (value instanceof Timestamp) {
    dt = DateTime.fromJSDate(value.toDate()).setZone(APP_SETTINGS.timezone);
  } else if (value.seconds) {
    dt = DateTime.fromSeconds(value.seconds).setZone(APP_SETTINGS.timezone);
  } else {
    dt = DateTime.fromISO(value, { zone: APP_SETTINGS.timezone });
  }
  return dt.toFormat('yyyy/M/d HH:mm');
}

async function setActiveDay(dayKey) {
  if (!state.profile) return;
  if (state.activeDayKey === dayKey) return;
  if (unsubscribers.day) {
    unsubscribers.day();
    unsubscribers.day = null;
  }
  if (unsubscribers.entries) {
    unsubscribers.entries();
    unsubscribers.entries = null;
  }
  state.activeDayKey = dayKey;
  dom.dayTitle.textContent =
    dayKey === state.todayKey ? '今日のスレッド' : `${dayKey} のスレッド`;
  dom.jumpToday.disabled = dayKey === state.todayKey;
  await ensureDayDocument(dayKey);
  const dayRef = doc(db, 'days', dayKey);
  unsubscribers.day = onSnapshot(dayRef, (snapshot) => {
    if (!snapshot.exists()) return;
    const data = snapshot.data();
    renderDayMeta(data);
    renderThanks(data.thanksBreakdown || {}, data.thanksTotal || 0);
    updateStatsFromDayDoc(dayKey, data);
    renderHistoryItem({ id: dayKey, ...data });
    updateStats().catch((error) =>
      console.error('統計更新に失敗しました', error)
    );
  });
  const entriesQuery = query(
    collection(dayRef, 'entries'),
    orderBy('updatedAt', 'desc')
  );
  unsubscribers.entries = onSnapshot(entriesQuery, (snapshot) => {
    const entries = snapshot.docs.reduce((acc, docSnap) => {
      acc[docSnap.id] = { id: docSnap.id, ...docSnap.data() };
      return acc;
    }, {});
    renderEntryCards(entries);
  });
}

async function ensureDayDocument(dayKey) {
  const { displayDate, weekKey } = getDateInfo(
    DateTime.fromISO(`${dayKey}T12:00:00`, { zone: APP_SETTINGS.timezone }),
    { respectCutoff: false }
  );
  const dayRef = doc(db, 'days', dayKey);
  await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(dayRef);
    if (!snapshot.exists()) {
      transaction.set(dayRef, {
        createdAt: serverTimestamp(),
        tz: APP_SETTINGS.timezone,
        date: dayKey,
        displayDate,
        weekKey,
        scoreSum: 0,
        scoreCount: 0,
        scoreAverage: null,
        thanksTotal: 0,
        thanksBreakdown: {
          master: 0,
          chii: 0,
        },
        lastAggregateAt: serverTimestamp(),
      });
    }
  });
}

function renderDayMeta(dayData) {
  const { displayDate } = dayData;
  const selected = state.activeDayKey;
  const isToday = selected === state.todayKey;
  const info = [];
  info.push(`<strong>${displayDate}</strong>`);
  if (isToday && state.isLateNight) {
    info.push('（0:00〜1:00の入力は前日扱いです）');
  }
  dom.dayMeta.innerHTML = info.join(' ');
}

function renderThanks(breakdown, total) {
  dom.thanksTotal.textContent = `合計 ${total}`;
  dom.thanksMaster.textContent = breakdown?.master ?? 0;
  dom.thanksChii.textContent = breakdown?.chii ?? 0;
}

function renderEntryCards(entries = {}) {
  const entriesByRole = { master: null, chii: null };
  Object.values(entries).forEach((entry) => {
    if (entry.role === 'master' || entry.role === 'chii') {
      entriesByRole[entry.role] = entry;
    }
  });
  renderEntryCard(dom.entryMaster, {
    role: 'master',
    entry: entriesByRole.master,
  });
  renderEntryCard(dom.entryChii, {
    role: 'chii',
    entry: entriesByRole.chii,
  });
}

function renderEntryCard(container, { role, entry }) {
  const isCurrentUser = state.profile?.role === role;
  container.innerHTML = '';
  const header = document.createElement('div');
  header.className = 'entry-card__header';
  const title = document.createElement('h3');
  title.className = 'entry-card__title';
  title.textContent = roleLabels[role] || role;
  const status = document.createElement('span');
  status.className = 'entry-card__status';
  status.textContent = entry
    ? `更新: ${formatDate(entry.updatedAt)}`
    : 'まだ入力がありません';
  header.append(title, status);
  container.appendChild(header);
  if (isCurrentUser) {
    const form = createEntryForm(role, entry);
    container.appendChild(form);
  } else {
    const viewer = document.createElement('div');
    viewer.className = 'entry-display';
    if (entry) {
      viewer.innerHTML = `
        <div class="entry-display__score">評価: ${scoreLabel(entry.score)}</div>
        <p>${escapeHtml(entry.note || '')}</p>
      `;
    } else {
      viewer.innerHTML = '<p>まだ入力がありません。</p>';
    }
    container.appendChild(viewer);
  }
}

function createEntryForm(role, entry) {
  const form = document.createElement('form');
  form.className = 'entry-form';
  form.innerHTML = `
    <label>
      <span>今日の自己評価</span>
      <select name="score" required>
        ${SCORE_OPTIONS.map(
          (option) => `
          <option value="${option.value}" ${
            Number(entry?.score) === option.value ? 'selected' : ''
          }>${option.label}</option>`
        ).join('')}
      </select>
    </label>
    <label>
      <span>感想・メモ</span>
      <textarea name="note" rows="6" placeholder="今日の出来事や感謝したいことを書いてください">${
        entry?.note ? escapeHtml(entry.note) : ''
      }</textarea>
    </label>
    <div class="entry-form__actions">
      <button type="submit" class="button button--primary">保存</button>
    </div>
  `;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(form);
    const score = Number(formData.get('score'));
    const note = formData.get('note')?.toString() ?? '';
    await saveEntry({ role, score, note });
    showToast('記録を保存しました');
  });
  return form;
}

async function saveEntry({ role, score, note }) {
  if (!state.profile || !state.activeDayKey) return;
  const dayRef = doc(db, 'days', state.activeDayKey);
  const entryRef = doc(collection(dayRef, 'entries'), state.profile.uid);
  await setDoc(entryRef, {
    role,
    score,
    note,
    updatedAt: serverTimestamp(),
  });
}

async function loadHistory(initial = false) {
  if (!state.profile) return;
  if (initial) {
    dom.historyList.innerHTML = '';
    state.historyCursor = null;
    state.historyHasMore = true;
  }
  if (!state.historyHasMore) return;
  let historyQuery = query(
    collection(db, 'days'),
    orderBy('date', 'desc'),
    limit(state.historyBatch)
  );
  if (state.historyCursor) {
    historyQuery = query(historyQuery, startAfter(state.historyCursor));
  }
  const snapshot = await getDocs(historyQuery);
  if (snapshot.empty) {
    state.historyHasMore = false;
    dom.historyLoadMore.disabled = true;
    return;
  }
  state.historyCursor = snapshot.docs[snapshot.docs.length - 1];
  snapshot.docs.forEach((docSnap) => {
    const data = docSnap.data();
    renderHistoryItem({ id: docSnap.id, ...data });
  });
  if (snapshot.docs.length < state.historyBatch) {
    state.historyHasMore = false;
    dom.historyLoadMore.disabled = true;
  } else {
    dom.historyLoadMore.disabled = false;
  }
  updateStats();
}

function renderHistoryItem(day) {
  let li = document.querySelector(`[data-history-id="${day.id}"]`);
  if (!li) {
    li = document.createElement('li');
    li.className = 'history-item';
    li.dataset.historyId = day.id;
    const openButton = document.createElement('button');
    openButton.type = 'button';
    openButton.className = 'button button--ghost';
    openButton.textContent = '開く';
    openButton.addEventListener('click', () => {
      setActiveDay(day.id);
      showToast(`${day.displayDate || day.id} を開きました`);
    });
    const summary = document.createElement('div');
    summary.className = 'history-item__summary';
    summary.innerHTML = '';
    li.append(summary, openButton);
    dom.historyList.appendChild(li);
  }
  const summary = li.querySelector('.history-item__summary');
  if (summary) {
    summary.innerHTML = `
      <strong>${day.displayDate || day.id}</strong>
      <span>平均スコア: ${day.scoreCount ? (day.scoreSum / day.scoreCount).toFixed(2) : '-'}</span>
      <span>ありがとう: ${day.thanksTotal ?? 0}</span>
    `;
  }
}

function scoreLabel(score) {
  const option = SCORE_OPTIONS.find((item) => item.value === Number(score));
  return option ? option.label : '-';
}

function renderAgreementsCollapsedState() {
  dom.toggleAgreementView.textContent = state.showAllAgreements
    ? '先頭のみ表示'
    : 'すべて表示';
  renderAgreementList();
}

async function handleAgreementSubmit(event) {
  event.preventDefault();
  const formData = new FormData(dom.modalForm);
  const title = formData.get('title')?.toString().trim();
  const body = formData.get('body')?.toString().trim();
  if (!title || !body) {
    showToast('タイトルと本文を入力してください');
    return;
  }
  if (!state.profile) return;
  try {
    if (modalMode === MODAL_MODE.CREATE) {
      await addDoc(collection(db, 'agreements'), {
        title,
        body,
        pinned: state.agreements.length === 0,
        order: state.agreements.length
          ? state.agreements[state.agreements.length - 1].order + 10
          : 100,
        status: 'active',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        createdBy: state.profile.uid,
        updatedBy: state.profile.uid,
      });
      showToast('決め事を追加しました');
    } else if (editingAgreementId) {
      await updateDoc(doc(db, 'agreements', editingAgreementId), {
        title,
        body,
        updatedAt: serverTimestamp(),
        updatedBy: state.profile.uid,
      });
      showToast('決め事を更新しました');
    }
    toggleModal(false);
  } catch (error) {
    console.error(error);
    showToast('決め事の保存に失敗しました');
  }
}

function openAgreementModal(mode, agreement = null) {
  modalMode = mode;
  editingAgreementId = agreement?.id || null;
  dom.modalTitle.textContent =
    mode === MODAL_MODE.CREATE ? '新しい決め事' : '決め事を編集';
  if (agreement) {
    dom.modalForm.title.value = agreement.title;
    dom.modalForm.body.value = agreement.body;
  } else {
    dom.modalForm.reset();
  }
  toggleModal(true);
}

async function updateAgreementPin(id, pinned) {
  await updateDoc(doc(db, 'agreements', id), {
    pinned,
    updatedAt: serverTimestamp(),
    updatedBy: state.profile.uid,
  });
  showToast(pinned ? 'ピン留めしました' : 'ピンを外しました');
}

async function archiveAgreement(id) {
  await updateDoc(doc(db, 'agreements', id), {
    status: 'archived',
    updatedAt: serverTimestamp(),
    updatedBy: state.profile.uid,
  });
  showToast('決め事をアーカイブしました');
}

function setupAgreementHandlers() {
  dom.toggleAgreementView.addEventListener('click', () => {
    state.showAllAgreements = !state.showAllAgreements;
    renderAgreementsCollapsedState();
  });
  dom.addAgreement.addEventListener('click', () =>
    openAgreementModal(MODAL_MODE.CREATE)
  );
  dom.modalCancel.addEventListener('click', () => toggleModal(false));
  dom.modalForm.addEventListener('submit', handleAgreementSubmit);
  dom.agreementList.addEventListener('click', (event) => {
    const action = event.target.dataset.action;
    if (!action) return;
    const item = event.target.closest('.agreement-item');
    if (!item) return;
    const agreement = state.agreements.find((ag) => ag.id === item.dataset.id);
    if (!agreement) return;
    if (action === AGREEMENT_ACTIONS.EDIT) {
      openAgreementModal(MODAL_MODE.EDIT, agreement);
    } else if (action === AGREEMENT_ACTIONS.TOGGLE_PIN) {
      updateAgreementPin(agreement.id, !agreement.pinned);
    } else if (action === AGREEMENT_ACTIONS.ARCHIVE) {
      if (state.profile?.role !== 'master') {
        showToast('アーカイブはマスターのみ可能です');
        return;
      }
      if (window.confirm('決め事をアーカイブしますか？')) {
        archiveAgreement(agreement.id);
      }
    }
  });
  enableAgreementDragAndDrop();
}

function enableAgreementDragAndDrop() {
  dom.agreementList.addEventListener('dragstart', (event) => {
    const item = event.target.closest('.agreement-item');
    if (!item) return;
    item.classList.add('dragging');
  });
  dom.agreementList.addEventListener('dragend', (event) => {
    const item = event.target.closest('.agreement-item');
    if (!item) return;
    item.classList.remove('dragging');
  });
  dom.agreementList.addEventListener('dragover', (event) => {
    event.preventDefault();
    const afterElement = getDragAfterElement(dom.agreementList, event.clientY);
    const draggable = dom.agreementList.querySelector('.dragging');
    if (!draggable) return;
    if (afterElement == null) {
      dom.agreementList.appendChild(draggable);
    } else {
      dom.agreementList.insertBefore(draggable, afterElement);
    }
  });
  dom.agreementList.addEventListener('drop', async () => {
    if (!state.profile) return;
    try {
      const newOrder = Array.from(dom.agreementList.children).map(
        (item, index) => ({
          id: item.dataset.id,
          order: (index + 1) * 100,
        })
      );
      await Promise.all(
        newOrder.map((item) =>
          updateDoc(doc(db, 'agreements', item.id), {
            order: item.order,
            updatedAt: serverTimestamp(),
            updatedBy: state.profile.uid,
          })
        )
      );
      showToast('決め事の順番を更新しました');
    } catch (error) {
      console.error(error);
      showToast('並び替えの保存に失敗しました');
    }
  });
}

function getDragAfterElement(container, y) {
  const draggableElements = [
    ...container.querySelectorAll('.agreement-item:not(.dragging)'),
  ];
  return draggableElements.reduce(
    (closest, child) => {
      const box = child.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closest.offset) {
        return { offset, element: child };
      }
      return closest;
    },
    { offset: Number.NEGATIVE_INFINITY }
  ).element;
}

async function handleThanksClick() {
  if (!state.profile || !state.activeDayKey) return;
  dom.thanksButton.disabled = true;
  try {
    await incrementThanksCallable({ dayKey: state.activeDayKey });
    showToast('ありがとうを贈りました');
  } catch (error) {
    console.error(error);
    showToast('ありがとうの送信に失敗しました');
  } finally {
    window.setTimeout(() => {
      dom.thanksButton.disabled = false;
    }, 400);
  }
}

function subscribeWeeklyComments() {
  if (unsubscribers.weeklyComments) {
    unsubscribers.weeklyComments();
    unsubscribers.weeklyComments = null;
  }
  const weeklyQuery = query(
    collection(db, 'weeklyComments'),
    orderBy('weekKey', 'desc'),
    limit(8)
  );
  unsubscribers.weeklyComments = onSnapshot(weeklyQuery, (snapshot) => {
    const comments = snapshot.docs.map((docSnap) => ({
      id: docSnap.id,
      ...docSnap.data(),
    }));
    renderWeeklyComments(comments);
  });
}

function renderWeeklyComments(comments) {
  dom.weeklyCurrent.innerHTML = '';
  dom.weeklyHistory.innerHTML = '';
  if (!comments.length) {
    dom.weeklyCurrent.innerHTML = '<p>まだ週次コメントがありません。</p>';
    return;
  }
  const [latest, ...rest] = comments;
  dom.weeklyCurrent.innerHTML = `
    <p class="weekly-comment__week">${latest.weekKey} のふりかえり</p>
    <p class="weekly-comment__text">${escapeHtml(latest.text || '')}</p>
  `;
  rest.forEach((item) => {
    const li = document.createElement('li');
    li.innerHTML = `
      <strong>${item.weekKey}</strong>
      <p class="weekly-comment__text">${escapeHtml(item.text || '')}</p>
    `;
    dom.weeklyHistory.appendChild(li);
  });
}

async function updateStats() {
  const daysSnapshot = await getDocs(
    query(collection(db, 'days'), orderBy('date', 'desc'), limit(60))
  );
  const days = daysSnapshot.docs.map((docSnap) => ({
    id: docSnap.id,
    ...docSnap.data(),
  }));
  applyStats(days);
  updateChart(days.slice().reverse());
}

function updateStatsFromDayDoc(dayKey, dayData) {
  if (dayKey === state.todayKey) {
    dom.statTodayScore.textContent = dayData.scoreCount
      ? (dayData.scoreSum / dayData.scoreCount).toFixed(2)
      : '-';
    dom.statTodayThanks.textContent = `ありがとう ${dayData.thanksTotal ?? 0}`;
  }
}

function applyStats(days) {
  const today = days.find((day) => day.id === state.todayKey);
  if (today) {
    dom.statTodayScore.textContent = today.scoreCount
      ? (today.scoreSum / today.scoreCount).toFixed(2)
      : '-';
    dom.statTodayThanks.textContent = `ありがとう ${today.thanksTotal ?? 0}`;
  }
  const now = DateTime.now().setZone(APP_SETTINGS.timezone, {
    keepLocalTime: false,
  });
  const weekKey = getDateInfo().weekKey;
  const monthKey = now.toFormat('yyyy-LL');
  let weekScoreSum = 0;
  let weekScoreCount = 0;
  let weekThanks = 0;
  let monthScoreSum = 0;
  let monthScoreCount = 0;
  let monthThanks = 0;
  days.forEach((day) => {
    if (day.weekKey === weekKey && day.scoreCount) {
      weekScoreSum += day.scoreSum || 0;
      weekScoreCount += day.scoreCount;
      weekThanks += day.thanksTotal || 0;
    }
    if (day.id.startsWith(monthKey)) {
      if (day.scoreCount) {
        monthScoreSum += day.scoreSum || 0;
        monthScoreCount += day.scoreCount;
      }
      monthThanks += day.thanksTotal || 0;
    }
  });
  dom.statWeekScore.textContent = weekScoreCount
    ? (weekScoreSum / weekScoreCount).toFixed(2)
    : '-';
  dom.statWeekThanks.textContent = `ありがとう ${weekThanks}`;
  dom.statMonthScore.textContent = monthScoreCount
    ? (monthScoreSum / monthScoreCount).toFixed(2)
    : '-';
  dom.statMonthThanks.textContent = `ありがとう ${monthThanks}`;
}

function updateChart(days) {
  if (typeof Chart === 'undefined') {
    return;
  }
  const labels = days.map((day) => day.displayDate || day.id);
  const averages = days.map((day) =>
    day.scoreCount ? Number((day.scoreSum / day.scoreCount).toFixed(2)) : null
  );
  const thanks = days.map((day) => day.thanksTotal || 0);
  if (state.chart) {
    state.chart.data.labels = labels;
    state.chart.data.datasets[0].data = averages;
    state.chart.data.datasets[1].data = thanks;
    state.chart.update();
    return;
  }
  state.chart = new Chart(dom.trendCanvas.getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: '平均スコア',
          data: averages,
          borderColor: '#e38383',
          backgroundColor: 'rgba(227, 131, 131, 0.2)',
          tension: 0.3,
          yAxisID: 'y',
        },
        {
          label: 'ありがとう',
          data: thanks,
          borderColor: '#f2a7a7',
          backgroundColor: 'rgba(242, 167, 167, 0.2)',
          type: 'bar',
          yAxisID: 'y1',
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false,
      },
      scales: {
        y: {
          type: 'linear',
          position: 'left',
          min: 0,
          max: 4,
          ticks: {
            stepSize: 1,
          },
        },
        y1: {
          type: 'linear',
          position: 'right',
          grid: {
            drawOnChartArea: false,
          },
          ticks: {
            stepSize: 1,
          },
        },
      },
    },
  });
}

function bindGlobalEvents() {
  dom.loginButton.addEventListener('click', async () => {
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
    } catch (error) {
      console.error(error);
      showToast('ログインに失敗しました');
    }
  });
  dom.logoutButton.addEventListener('click', () => {
    signOut(auth);
  });
  dom.thanksButton.addEventListener('click', handleThanksClick);
  dom.historyLoadMore.addEventListener('click', () => loadHistory(false));
  dom.jumpToday.addEventListener('click', () => {
    if (state.todayKey) {
      setActiveDay(state.todayKey);
    }
  });
  setupAgreementHandlers();
  dom.modalBackdrop.addEventListener('click', (event) => {
    if (event.target === dom.modalBackdrop) {
      toggleModal(false);
    }
  });
}

async function bootstrap() {
  bindGlobalEvents();
  await setPersistence(auth, browserLocalPersistence);
  onAuthStateChanged(auth, handleAuthState);
}

bootstrap().catch((error) => {
  console.error('アプリ初期化中にエラーが発生しました', error);
  showToast('アプリの初期化に失敗しました');
});
