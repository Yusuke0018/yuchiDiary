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
  startAt,
  endAt,
  Timestamp,
  updateDoc,
} from 'https://www.gstatic.com/firebasejs/10.13.1/firebase-firestore.js';
import {
  getFunctions,
  httpsCallable,
} from 'https://www.gstatic.com/firebasejs/10.13.1/firebase-functions.js';

// Luxonがグローバルに読み込まれているかチェック
if (typeof luxon === 'undefined') {
  console.error('Luxonライブラリが読み込まれていません');
  throw new Error('Luxonライブラリが見つかりません');
}
const { DateTime, Settings } = luxon;

// Luxon設定
try {
  Settings.defaultLocale = 'ja-JP';
  Settings.defaultZone = APP_SETTINGS.timezone;
} catch (error) {
  console.error('Luxon設定エラー:', error);
  throw error;
}

// Firebase初期化
let firebaseApp;
try {
  if (!firebaseConfig || !firebaseConfig.apiKey) {
    throw new Error('Firebase設定が正しく読み込まれていません');
  }
  firebaseApp = initializeApp(firebaseConfig);
  console.log('Firebase初期化成功');
} catch (error) {
  console.error('Firebase初期化エラー:', error);
  throw error;
}
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);
const functions = getFunctions(firebaseApp, 'asia-northeast1');
const incrementThanksCallable = httpsCallable(functions, 'incrementThanks');

const userIndex = {};
APP_USERS.forEach((user) => {
  if (user && user.email) {
    userIndex[user.email] = user;
  }
});
const roleLabels = APP_USERS.reduce((acc, user) => {
  acc[user.role] = user.displayName;
  return acc;
}, {});

const ROLES = ['master', 'chii'];
const PARTNER_ROLE = {
  master: 'chii',
  chii: 'master',
};

const ROLE_CHART_STYLE = {
  master: {
    scoreBorder: '#8f6bff',
    scoreBackground: 'rgba(143, 107, 255, 0.22)',
    thanksBorder: 'rgba(143, 107, 255, 0.7)',
    thanksBackground: 'rgba(143, 107, 255, 0.32)',
  },
  chii: {
    scoreBorder: '#5ccfc0',
    scoreBackground: 'rgba(92, 207, 192, 0.24)',
    thanksBorder: 'rgba(92, 207, 192, 0.7)',
    thanksBackground: 'rgba(92, 207, 192, 0.32)',
  },
};

const scoreBreakdownCache = new Map();

function getDisplayNameByRole(role) {
  return roleLabels[role] || role;
}

function getPartnerRole(role) {
  return PARTNER_ROLE[role] || null;
}

function getRecipientNickname(role, fallback) {
  if (role === 'chii') {
    return 'ちいちゃん';
  }
  if (role === 'master') {
    return 'ゆうちゃん';
  }
  return fallback || 'パートナー';
}

const state = {
  authUser: null,
  profile: null,
  activeDayKey: null,
  todayKey: null,
  isLateNight: false,
  agreements: [],
  historyMonth: null,
  historyDays: {},
  historyLoadedMonths: {},
  historySelectedDay: null,
  historyDayEntries: {},
  autoUpdate: {
    currentVersion: null,
    pendingVersion: null,
    checkTimerId: null,
    idleTimerId: null,
    visibilityHandler: null,
    reloadPending: false,
  },
  chart: null,
  activeView: 'today',
};

const unsubscribers = {
  agreements: null,
  day: null,
  entries: null,
  weeklyComments: null,
};

const autoUpdateConfig = (() => {
  const base = {
    enabled: true,
    checkIntervalMs: 5 * 60 * 1000,
    idleReloadDelayMs: 60 * 1000,
    endpoint: 'version.txt',
  };
  if (APP_SETTINGS && APP_SETTINGS.autoUpdate) {
    const cfg = APP_SETTINGS.autoUpdate;
    if (Object.prototype.hasOwnProperty.call(cfg, 'enabled')) {
      base.enabled = Boolean(cfg.enabled);
    }
    if (typeof cfg.checkIntervalMs === 'number' && cfg.checkIntervalMs > 0) {
      base.checkIntervalMs = cfg.checkIntervalMs;
    }
    if (
      typeof cfg.idleReloadDelayMs === 'number' &&
      cfg.idleReloadDelayMs > 0
    ) {
      base.idleReloadDelayMs = cfg.idleReloadDelayMs;
    }
    if (typeof cfg.endpoint === 'string' && cfg.endpoint.trim()) {
      base.endpoint = cfg.endpoint.trim();
    }
  }
  if (
    typeof window !== 'undefined' &&
    window &&
    window.__YUCHI_DIARY_DISABLE_AUTO_UPDATE === true
  ) {
    base.enabled = false;
  }
  return base;
})();

function collectViewSections() {
  const sections = {};
  const elements = document.querySelectorAll('.view-section[data-view]');
  elements.forEach((section) => {
    if (!section || !section.dataset) {
      return;
    }
    const key = section.dataset.view;
    if (key && !sections[key]) {
      sections[key] = section;
    }
  });
  return sections;
}

function getThanksKeys() {
  const role =
    state.profile && state.profile.role === 'chii' ? 'chii' : 'master';
  return {
    sentKey: role,
    receivedKey: role === 'master' ? 'chii' : 'master',
  };
}

function getThanksSplitFromBreakdown(breakdown) {
  if (!breakdown || typeof breakdown !== 'object') {
    return { sent: 0, received: 0 };
  }
  const { sentKey, receivedKey } = getThanksKeys();
  const sent = Number(breakdown[sentKey] || 0);
  const received = Number(breakdown[receivedKey] || 0);
  return { sent, received };
}

function renderThanksStat(sentNode, receivedNode, sent, received) {
  if (sentNode) {
    sentNode.textContent = `贈った ${Number.isFinite(sent) ? sent : 0}`;
  }
  if (receivedNode) {
    receivedNode.textContent = `もらった ${Number.isFinite(received) ? received : 0}`;
  }
}

function parseVersionDescriptor(text) {
  if (!text) {
    return null;
  }
  const trimmed = String(text).trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    console.info(
      'version.txt は JSON 解析に失敗したため、key=value 形式で処理します。',
      error
    );
    const lines = trimmed.split(/\r?\n/);
    const descriptor = {};
    lines.forEach((line) => {
      const cleaned = line.trim();
      if (!cleaned || cleaned.startsWith('#')) {
        return;
      }
      const separatorIndex = cleaned.indexOf('=');
      if (separatorIndex === -1) {
        return;
      }
      const key = cleaned.slice(0, separatorIndex).trim();
      const value = cleaned.slice(separatorIndex + 1).trim();
      if (key) {
        descriptor[key] = value;
      }
    });
    if (!descriptor.version && descriptor.commit) {
      descriptor.version = descriptor.commit;
    }
    return Object.keys(descriptor).length ? descriptor : null;
  }
}

async function fetchVersionDescriptor() {
  try {
    const endpoint = autoUpdateConfig.endpoint || 'version.txt';
    const response = await fetch(`${endpoint}?t=${Date.now()}`, {
      cache: 'no-store',
    });
    if (!response.ok) {
      throw new Error(`Version request failed: ${response.status}`);
    }
    const text = await response.text();
    return parseVersionDescriptor(text);
  } catch (error) {
    console.info('バージョン情報の取得に失敗しました', error);
    return null;
  }
}

function clearAutoUpdatePolling() {
  if (state.autoUpdate && state.autoUpdate.checkTimerId) {
    clearTimeout(state.autoUpdate.checkTimerId);
    state.autoUpdate.checkTimerId = null;
  }
}

function clearAutoUpdateReloadGuards() {
  if (state.autoUpdate && state.autoUpdate.idleTimerId) {
    clearTimeout(state.autoUpdate.idleTimerId);
    state.autoUpdate.idleTimerId = null;
  }
  if (state.autoUpdate && state.autoUpdate.visibilityHandler) {
    document.removeEventListener(
      'visibilitychange',
      state.autoUpdate.visibilityHandler
    );
    state.autoUpdate.visibilityHandler = null;
  }
}

function scheduleAutoUpdateCheck(delay) {
  if (!autoUpdateConfig.enabled || !state.autoUpdate) {
    return;
  }
  const interval =
    typeof delay === 'number' && delay > 0
      ? delay
      : autoUpdateConfig.checkIntervalMs;
  clearAutoUpdatePolling();
  state.autoUpdate.checkTimerId = setTimeout(() => {
    executeAutoUpdateCheck().catch((error) => {
      console.info('自動更新チェックに失敗しました', error);
      scheduleAutoUpdateCheck();
    });
  }, interval);
}

async function executeAutoUpdateCheck() {
  if (!autoUpdateConfig.enabled || !state.autoUpdate) {
    return;
  }
  state.autoUpdate.checkTimerId = null;
  const descriptor = await fetchVersionDescriptor();
  if (!descriptor || !descriptor.version) {
    scheduleAutoUpdateCheck();
    return;
  }
  if (!state.autoUpdate.currentVersion) {
    state.autoUpdate.currentVersion = descriptor.version;
    scheduleAutoUpdateCheck();
    return;
  }
  if (descriptor.version === state.autoUpdate.currentVersion) {
    scheduleAutoUpdateCheck();
    return;
  }
  state.autoUpdate.pendingVersion = descriptor;
  notifyAutoUpdateAvailable();
}

function reloadToLatest() {
  clearAutoUpdatePolling();
  clearAutoUpdateReloadGuards();
  window.location.reload();
}

function attemptAutoReloadWhenIdle() {
  if (!state.autoUpdate) {
    return;
  }
  if (document.visibilityState === 'hidden') {
    reloadToLatest();
    return;
  }
  if (!state.autoUpdate.visibilityHandler) {
    const handler = () => {
      if (document.visibilityState === 'hidden') {
        reloadToLatest();
      }
    };
    state.autoUpdate.visibilityHandler = handler;
    document.addEventListener('visibilitychange', handler);
  }
  clearTimeout(state.autoUpdate.idleTimerId);
  state.autoUpdate.idleTimerId = setTimeout(() => {
    reloadToLatest();
  }, autoUpdateConfig.idleReloadDelayMs);
}

function notifyAutoUpdateAvailable() {
  if (!state.autoUpdate || state.autoUpdate.reloadPending) {
    return;
  }
  state.autoUpdate.reloadPending = true;
  if (typeof showToast === 'function') {
    showToast('新しいバージョンを準備中です…');
  }
  attemptAutoReloadWhenIdle();
}

async function initializeAutoUpdateMonitor() {
  if (!autoUpdateConfig.enabled || !state.autoUpdate) {
    return;
  }
  const descriptor = await fetchVersionDescriptor();
  if (descriptor && descriptor.version) {
    state.autoUpdate.currentVersion = descriptor.version;
  }
  scheduleAutoUpdateCheck(autoUpdateConfig.checkIntervalMs);
}
function setupViewSwipe() {
  const container = dom.main;
  if (!container) {
    return;
  }
  const viewOrder = ['today', 'agreements', 'history', 'stats'];
  const interactiveSelector =
    'input, textarea, select, button, a, [role="button"], [contenteditable="true"]';

  let startX = 0;
  let startY = 0;
  let tracking = false;
  let handled = false;

  const reset = () => {
    tracking = false;
    handled = false;
  };

  container.addEventListener(
    'touchstart',
    (event) => {
      if (!event.touches || event.touches.length !== 1) {
        return;
      }
      const targetNode = event.target;
      if (targetNode && targetNode.closest(interactiveSelector)) {
        return;
      }
      const touch = event.touches[0];
      startX = touch.clientX;
      startY = touch.clientY;
      tracking = true;
      handled = false;
    },
    { passive: true }
  );

  container.addEventListener(
    'touchmove',
    (event) => {
      if (!tracking || !event.touches || event.touches.length !== 1) {
        return;
      }
      const touch = event.touches[0];
      const deltaX = touch.clientX - startX;
      const deltaY = touch.clientY - startY;

      if (!handled) {
        if (Math.abs(deltaX) > Math.abs(deltaY) + 8 && Math.abs(deltaX) > 10) {
          handled = true;
          event.preventDefault();
        } else if (Math.abs(deltaY) > Math.abs(deltaX) + 8) {
          reset();
        }
      } else {
        event.preventDefault();
      }
    },
    { passive: false }
  );

  const goToStep = (direction) => {
    const currentIndex = Math.max(
      0,
      viewOrder.indexOf(state.activeView || 'today')
    );
    const nextIndex =
      (currentIndex + direction + viewOrder.length) % viewOrder.length;
    const nextView = viewOrder[nextIndex];
    if (nextView) {
      setActiveView(nextView);
    }
  };

  const handleSwipeEnd = (event) => {
    if (!tracking) {
      return;
    }
    const changedTouches = event.changedTouches;
    if (!handled || !changedTouches || changedTouches.length !== 1) {
      reset();
      return;
    }
    const touch = changedTouches[0];
    const deltaX = touch.clientX - startX;
    if (Math.abs(deltaX) < 45) {
      reset();
      return;
    }
    if (deltaX < 0) {
      goToStep(1);
    } else {
      goToStep(-1);
    }
    reset();
  };

  container.addEventListener('touchend', handleSwipeEnd, { passive: true });
  container.addEventListener('touchcancel', reset, { passive: true });
}

const dom = {
  loginButton: document.getElementById('login-button'),
  logoutButton: document.getElementById('logout-button'),
  userPanel: document.getElementById('user-panel'),
  userName: document.getElementById('user-name'),
  signedOut: document.getElementById('signed-out'),
  main: document.getElementById('main-content'),
  agreementList: document.getElementById('agreement-list'),
  agreementEmpty: document.getElementById('agreement-empty'),
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
  historyMonthLabel: document.getElementById('history-month-label'),
  historyPrevMonth: document.getElementById('history-prev-month'),
  historyNextMonth: document.getElementById('history-next-month'),
  historyCalendar: document.querySelector('.history-calendar'),
  historyGrid: document.getElementById('history-grid'),
  historyDetail: document.getElementById('history-detail'),
  historyDetailDate: document.getElementById('history-detail-date'),
  historyDetailScore: document.getElementById('history-detail-score'),
  historyDetailThanks: document.getElementById('history-detail-thanks'),
  historyDetailThanksBreakdown: document.getElementById(
    'history-detail-thanks-breakdown'
  ),
  historyDetailEntries: document.getElementById('history-detail-entries'),
  historyOpenDay: document.getElementById('history-open-day'),
  jumpToday: document.getElementById('jump-today'),
  statTodayScore: document.getElementById('stat-today-score'),
  statTodayThanksSent: document.getElementById('stat-today-thanks-sent'),
  statTodayThanksReceived: document.getElementById(
    'stat-today-thanks-received'
  ),
  statWeekScore: document.getElementById('stat-week-score'),
  statWeekThanksSent: document.getElementById('stat-week-thanks-sent'),
  statWeekThanksReceived: document.getElementById('stat-week-thanks-received'),
  statMonthScore: document.getElementById('stat-month-score'),
  statMonthThanksSent: document.getElementById('stat-month-thanks-sent'),
  statMonthThanksReceived: document.getElementById(
    'stat-month-thanks-received'
  ),
  statPerson: {
    master: {
      todayScore: document.getElementById('stat-master-today-score'),
      todayThanks: document.getElementById('stat-master-today-thanks'),
      weekScore: document.getElementById('stat-master-week-score'),
      weekThanks: document.getElementById('stat-master-week-thanks'),
      monthScore: document.getElementById('stat-master-month-score'),
      monthThanks: document.getElementById('stat-master-month-thanks'),
    },
    chii: {
      todayScore: document.getElementById('stat-chii-today-score'),
      todayThanks: document.getElementById('stat-chii-today-thanks'),
      weekScore: document.getElementById('stat-chii-week-score'),
      weekThanks: document.getElementById('stat-chii-week-thanks'),
      monthScore: document.getElementById('stat-chii-month-score'),
      monthThanks: document.getElementById('stat-chii-month-thanks'),
    },
  },
  trendCanvas: document.getElementById('trend-chart'),
  weeklyCurrent: document.getElementById('weekly-comment-current'),
  weeklyHistory: document.getElementById('weekly-comment-history'),
  toast: document.getElementById('toast'),
  navButtons: document.querySelectorAll('.tab-nav__button'),
  viewSections: collectViewSections(),
  modalDelete: document.getElementById('modal-delete'),
  viewSwitcher: document.querySelector('.view-switcher'),
  viewSelect: document.getElementById('view-select'),
};

function forEachNode(list, callback) {
  if (!list || typeof callback !== 'function') {
    return;
  }
  for (let index = 0; index < list.length; index += 1) {
    callback(list[index], index);
  }
}

function getObjectEntries(target) {
  const entries = [];
  if (!target || typeof target !== 'object') {
    return entries;
  }
  for (const key in target) {
    if (Object.prototype.hasOwnProperty.call(target, key)) {
      entries.push([key, target[key]]);
    }
  }
  return entries;
}

function getObjectValues(target) {
  const values = [];
  if (!target || typeof target !== 'object') {
    return values;
  }
  for (const key in target) {
    if (Object.prototype.hasOwnProperty.call(target, key)) {
      values.push(target[key]);
    }
  }
  return values;
}

function findAgreementById(id) {
  if (!id) {
    return null;
  }
  for (let index = 0; index < state.agreements.length; index += 1) {
    const agreement = state.agreements[index];
    if (agreement && agreement.id === id) {
      return agreement;
    }
  }
  return null;
}

function findScoreOptionByValue(value) {
  for (let index = 0; index < SCORE_OPTIONS.length; index += 1) {
    const option = SCORE_OPTIONS[index];
    if (option && Number(option.value) === Number(value)) {
      return option;
    }
  }
  return null;
}

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
let agreementPressTimer = null;
let agreementPressTargetId = null;

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
  if (!email) {
    return null;
  }
  return userIndex[email] || null;
}

function setActiveView(view) {
  console.log(`ビューを切り替え: ${view}`);

  if (!dom.viewSections || !dom.viewSections[view]) {
    dom.viewSections = collectViewSections();
  }

  if (!dom.viewSections || !dom.viewSections[view]) {
    console.warn('Unknown view', view);
    return;
  }

  state.activeView = view;

  // すべてのセクションを非表示にして、選択されたものだけを表示
  getObjectEntries(dom.viewSections).forEach((entry) => {
    const key = entry[0];
    const section = entry[1];
    if (!section) {
      console.warn(`ビューセクション ${key} が見つかりません`);
      return;
    }
    const shouldHide = key !== view;
    section.classList.toggle('hidden', shouldHide);
    console.log(`${key} セクション: ${shouldHide ? '非表示' : '表示'}`);
  });

  if (dom.viewSelect && dom.viewSelect.value !== view) {
    dom.viewSelect.value = view;
  }

  // ナビゲーションボタンのアクティブ状態を更新
  forEachNode(dom.navButtons, (button) => {
    if (!button || !button.classList) {
      return;
    }
    button.classList.toggle(
      'tab-nav__button--active',
      button.dataset && button.dataset.view === view
    );
  });

  // 特定のビューに対する追加処理
  if (view === 'agreements') {
    const agreementCount = Array.isArray(state.agreements)
      ? state.agreements.length
      : 0;
    console.log('決め事ビューを表示、現在の決め事数:', agreementCount);
  }

  if (view === 'history') {
    loadHistoryMonth().catch((error) =>
      console.error('履歴の読み込みに失敗:', error)
    );
  }

  if (view === 'stats') {
    updateStats();
  }
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
    initializeAppData()
      .then(() => {
        setActiveView('today');
      })
      .catch((error) => {
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
    if (dom.historyGrid) {
      dom.historyGrid.innerHTML = '';
    }
    if (dom.historyDetailEntries) {
      dom.historyDetailEntries.innerHTML = '';
    }
    if (dom.historyDetailDate) {
      dom.historyDetailDate.textContent = '日付を選択してください';
    }
    if (dom.historyDetailScore) {
      dom.historyDetailScore.textContent = '平均スコア: -';
    }
    if (dom.historyDetailThanks) {
      dom.historyDetailThanks.textContent = 'ありがとう合計: -';
    }
    if (dom.historyDetailThanksBreakdown) {
      dom.historyDetailThanksBreakdown.textContent = '祐介: - / 千里: -';
    }
    if (dom.historyOpenDay) {
      dom.historyOpenDay.disabled = true;
    }
    state.historyDays = {};
    state.historyLoadedMonths = {};
    state.historySelectedDay = null;
    state.historyDayEntries = {};
    state.historyMonth = null;
    dom.agreementList.innerHTML = '';
    dom.weeklyCurrent.innerHTML = '';
    dom.weeklyHistory.innerHTML = '';
    if (state.chart) {
      state.chart.destroy();
      state.chart = null;
    }
    setActiveView('today');
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
  console.log('アプリデータの初期化を開始');

  try {
    await ensureUserProfile();
    console.log('ユーザープロフィールを確認');

    const { dayKey, isLateNight } = getDateInfo();
    state.todayKey = dayKey;
    state.isLateNight = isLateNight;
    console.log(`今日の日付: ${dayKey}, 深夜モード: ${isLateNight}`);

    await setActiveDay(dayKey);
    console.log('今日の日付データを設定');

    // 決め事のサブスクライブ
    subscribeAgreements();

    // 履歴データの準備
    state.historyDays = {};
    state.historyLoadedMonths = {};
    state.historyDayEntries = {};
    state.historySelectedDay = null;
    state.historyMonth = DateTime.fromISO(`${dayKey}T00:00:00`, {
      zone: APP_SETTINGS.timezone,
    }).startOf('month');
    await loadHistoryMonth({ force: true });
    console.log('履歴データを読み込み');

    // 週次コメントのサブスクライブ
    subscribeWeeklyComments();
    console.log('週次コメントをサブスクライブ');

    console.log('アプリデータの初期化完了');
  } catch (error) {
    console.error('アプリデータの初期化中にエラー:', error);
    throw error;
  }
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
  console.log('決め事のサブスクライブを開始');

  if (unsubscribers.agreements) {
    unsubscribers.agreements();
    unsubscribers.agreements = null;
  }

  try {
    const agreementsQuery = query(
      collection(db, 'agreements'),
      orderBy('order', 'asc')
    );

    unsubscribers.agreements = onSnapshot(
      agreementsQuery,
      (snapshot) => {
        console.log(`決め事を${snapshot.size}件取得`);

        if (!snapshot.size && !agreementsSeeded) {
          console.log('決め事が空のため、デフォルトを設定');
          seedDefaultAgreements().catch((error) => {
            agreementsSeeded = false;
            console.error('決め事の初期設定に失敗:', error);
            showToast('決め事の初期設定に失敗しました');
          });
        }

        const agreements = snapshot.docs.map((docSnap) => ({
          id: docSnap.id,
          ...docSnap.data(),
        }));

        agreements.sort((a, b) => {
          const pinnedDiff = (b && b.pinned ? 1 : 0) - (a && a.pinned ? 1 : 0);
          if (pinnedDiff !== 0) {
            return pinnedDiff;
          }
          const orderA =
            typeof a.order === 'number' ? a.order : Number.MAX_SAFE_INTEGER;
          const orderB =
            typeof b.order === 'number' ? b.order : Number.MAX_SAFE_INTEGER;
          return orderA - orderB;
        });

        state.agreements = agreements.filter(
          (item) => item.status !== 'archived'
        );

        console.log('決め事リストをレンダリング:', state.agreements);
        renderAgreementList();
      },
      (error) => {
        console.error('Firestoreから決め事の取得に失敗:', error);

        // エラーの種類に応じたメッセージ
        let errorMessage = '決め事の読み込みに失敗しました';
        if (error.code === 'permission-denied') {
          errorMessage = '決め事にアクセスする権限がありません';
        } else if (error.code === 'failed-precondition') {
          errorMessage = 'Firestoreのインデックスが不足しています';
        } else if (error.message && error.message.indexOf('offline') !== -1) {
          errorMessage = 'オフラインのため決め事を取得できません';
        }

        showToast(errorMessage);

        // エラー時でも空のリストを表示
        state.agreements = [];
        renderAgreementList();
      }
    );
  } catch (error) {
    console.error('決め事クエリの作成に失敗:', error);
    showToast('決め事の読み込み設定に失敗しました');

    // エラー時でも空のリストを表示
    state.agreements = [];
    renderAgreementList();
  }
}

async function seedDefaultAgreements() {
  if (!state.profile) {
    console.warn('プロフィールがないため、デフォルト決め事を設定できません');
    return;
  }

  console.log('デフォルト決め事の設定を開始');
  agreementsSeeded = true;

  try {
    let createdCount = 0;
    await Promise.all(
      DEFAULT_AGREEMENTS.map(async (title, index) => {
        const docRef = doc(db, 'agreements', `seed-${index}`);
        const existing = await getDoc(docRef);
        if (existing.exists()) {
          console.log(`決め事 seed-${index} は既に存在`);
          return;
        }

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

        console.log(`決め事 seed-${index} を作成: ${title}`);
        createdCount += 1;
      })
    );

    if (createdCount > 0) {
      console.log(`${createdCount}件のデフォルト決め事を登録`);
      showToast('夫婦の決め事を初期登録しました');
    } else {
      console.log('デフォルト決め事は既に登録済み');
    }
  } catch (error) {
    console.error('デフォルト決め事の設定に失敗:', error);
    agreementsSeeded = false;
    throw error;
  }
}

function renderAgreementList() {
  const items = state.agreements || [];

  console.log(`決め事リストをレンダリング: ${items.length}件`);

  // DOM要素の存在確認
  if (!dom.agreementList) {
    console.error('決め事リストのDOM要素が見つかりません');
    return;
  }

  dom.agreementList.innerHTML = '';

  if (!items.length) {
    if (dom.agreementEmpty) {
      dom.agreementEmpty.classList.remove('hidden');
    }
    return;
  }

  if (dom.agreementEmpty) {
    dom.agreementEmpty.classList.add('hidden');
  }

  items.forEach((item) => {
    const li = document.createElement('li');
    li.className = 'agreement-item';
    li.dataset.id = item.id;
    li.innerHTML = `
      
      <div class="agreement-item__content">
        <p class="agreement-item__title-text">${escapeHtml(item.title)}</p>
        ${item.body ? `<p class="agreement-item__note">${escapeHtml(item.body)}</p>` : ''}
      </div>
    `;
    dom.agreementList.appendChild(li);
  });
}

function escapeHtml(text) {
  const value = text == null ? '' : String(text);
  const escapeMap = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  };
  return value.replace(/[&<>"']/g, (match) => escapeMap[match] || match);
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
    updateHistoryDayState(dayKey, data);
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
  const totalValue = typeof total === 'number' ? total : 0;
  const masterValue =
    breakdown && typeof breakdown.master === 'number' ? breakdown.master : 0;
  const chiiValue =
    breakdown && typeof breakdown.chii === 'number' ? breakdown.chii : 0;
  dom.thanksTotal.textContent = `合計 ${totalValue}`;
  dom.thanksMaster.textContent = masterValue;
  dom.thanksChii.textContent = chiiValue;
}

function renderEntryCards(entries = {}) {
  const entriesByRole = { master: null, chii: null };
  const entryList = getObjectValues(entries);
  entryList.forEach((entry) => {
    if (entry && (entry.role === 'master' || entry.role === 'chii')) {
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
  const isCurrentUser = state.profile && state.profile.role === role;
  container.innerHTML = '';
  const header = document.createElement('div');
  header.className = 'entry-card__header';
  const title = document.createElement('h3');
  title.className = 'entry-card__title';
  title.textContent = `${getDisplayNameByRole(role)}のメッセージ`;
  const status = document.createElement('span');
  status.className = 'entry-card__status';
  status.textContent = entry
    ? `最終更新: ${formatDate(entry.updatedAt)}`
    : 'まだ入力がありません';
  header.append(title, status);
  container.appendChild(header);
  const partnerRole = getPartnerRole(role);
  const partnerName = partnerRole ? getDisplayNameByRole(partnerRole) : null;
  const recipientNickname = getRecipientNickname(partnerRole, partnerName);
  const recipientLabel = `${recipientNickname}へ`;
  const names = document.createElement('div');
  names.className = 'entry-card__names';
  const recipientChip = document.createElement('span');
  recipientChip.className = 'entry-card__name';
  if (partnerRole) {
    recipientChip.classList.add(`entry-card__name--${partnerRole}`);
  }
  recipientChip.textContent = recipientLabel;
  names.append(recipientChip);
  container.appendChild(names);
  if (isCurrentUser) {
    const form = createEntryForm(role, entry, partnerName, recipientNickname);
    container.appendChild(form);
  } else {
    const viewer = document.createElement('div');
    viewer.className = 'entry-display';
    const meta = document.createElement('div');
    meta.className = 'entry-display__meta';
    const recipient = document.createElement('span');
    recipient.className = 'entry-display__recipient';
    recipient.textContent = `${recipientNickname}へのメッセージ`;
    const scoreInfo = document.createElement('span');
    scoreInfo.className = 'entry-display__score';
    scoreInfo.textContent = `今日のスコア: ${
      entry ? scoreLabel(entry.score) : '-'
    }`;
    meta.append(recipient, scoreInfo);
    viewer.appendChild(meta);
    const message = document.createElement('p');
    message.className = 'entry-display__message';
    if (entry && entry.note && String(entry.note).trim()) {
      message.textContent = entry.note;
    } else {
      message.classList.add('entry-display__message--empty');
      message.textContent = 'メッセージはまだありません。';
    }
    viewer.appendChild(message);
    container.appendChild(viewer);
  }
}

function createEntryForm(role, entry, partnerName, recipientNickname) {
  const form = document.createElement('form');
  form.className = 'entry-form';
  const selectedScore =
    entry && typeof entry.score === 'number' ? Number(entry.score) : null;
  const noteValue = entry && typeof entry.note === 'string' ? entry.note : '';
  const nickname = recipientNickname || partnerName || 'パートナー';
  const messageLabel = `${nickname}へのメッセージ`;
  const messagePlaceholder = `${nickname}に伝えたいことを丁寧に書きましょう`;
  const hint = `保存すると${nickname}の画面に届きます。`;
  form.innerHTML = `
    <div class="entry-form__meta">
      <span class="entry-form__recipient">${escapeHtml(messageLabel)}</span>
      <span class="entry-form__hint">${escapeHtml(hint)}</span>
    </div>
    <label>
      <span>今日の自己評価</span>
      <select name="score" required>
        ${SCORE_OPTIONS.map(
          (option) => `
          <option value="${option.value}" ${
            selectedScore === option.value ? 'selected' : ''
          }>${option.label}</option>`
        ).join('')}
      </select>
    </label>
    <label class="entry-form__field">
      <span>${escapeHtml(messageLabel)}</span>
      <textarea name="note" rows="6" placeholder="${escapeHtml(
        messagePlaceholder
      )}">${noteValue ? escapeHtml(noteValue) : ''}</textarea>
    </label>
    <div class="entry-form__actions">
      <button type="submit" class="button button--primary">保存</button>
    </div>
  `;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(form);
    const score = Number(formData.get('score'));
    const rawNote = formData.get('note');
    const note = rawNote == null ? '' : String(rawNote);
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

function getMonthKey(dateTime) {
  if (!dateTime) return '';
  return dateTime.toFormat('yyyy-LL');
}

function isDayInMonth(dayKey, monthDateTime) {
  if (!dayKey || !monthDateTime) {
    return false;
  }
  const dt = DateTime.fromISO(`${dayKey}T00:00:00`, {
    zone: APP_SETTINGS.timezone,
  });
  return dt.year === monthDateTime.year && dt.month === monthDateTime.month;
}

function ensureHistoryMonthInitialized() {
  if (state.historyMonth) {
    return;
  }
  const { current } = getDateInfo();
  state.historyMonth = current.startOf('month');
}

function updateHistoryMonthLabel() {
  if (!dom.historyMonthLabel || !state.historyMonth) {
    return;
  }
  dom.historyMonthLabel.textContent = state.historyMonth.toFormat('yyyy年M月');
}

function ensureHistorySelectedDay() {
  ensureHistoryMonthInitialized();
  if (
    state.historySelectedDay &&
    isDayInMonth(state.historySelectedDay, state.historyMonth)
  ) {
    return;
  }
  const todayKey = state.todayKey;
  if (todayKey && isDayInMonth(todayKey, state.historyMonth)) {
    state.historySelectedDay = todayKey;
    return;
  }
  const monthKeys = Object.keys(state.historyDays)
    .filter((key) => isDayInMonth(key, state.historyMonth))
    .sort();
  state.historySelectedDay = monthKeys.length ? monthKeys[0] : null;
}

async function loadHistoryMonth({ force = false } = {}) {
  if (!state.profile) return;
  ensureHistoryMonthInitialized();
  const monthKey = getMonthKey(state.historyMonth);
  if (!force && state.historyLoadedMonths[monthKey]) {
    updateHistoryMonthLabel();
    ensureHistorySelectedDay();
    renderHistoryCalendar();
    renderHistoryDetail(state.historySelectedDay);
    return;
  }
  const startKey = state.historyMonth.startOf('month').toFormat('yyyy-LL-dd');
  const endKey = state.historyMonth.endOf('month').toFormat('yyyy-LL-dd');
  const historyQuery = query(
    collection(db, 'days'),
    orderBy('date'),
    startAt(startKey),
    endAt(endKey)
  );
  const snapshot = await getDocs(historyQuery);
  snapshot.docs.forEach((docSnap) => {
    state.historyDays[docSnap.id] = { id: docSnap.id, ...docSnap.data() };
  });
  state.historyLoadedMonths[monthKey] = true;
  updateHistoryMonthLabel();
  ensureHistorySelectedDay();
  renderHistoryCalendar();
  renderHistoryDetail(state.historySelectedDay);
  updateStats();
}

function changeHistoryMonth(offset) {
  if (!state.profile) return;
  ensureHistoryMonthInitialized();
  state.historyMonth = state.historyMonth.plus({ months: offset });
  state.historySelectedDay = null;
  loadHistoryMonth({ force: true }).catch((error) =>
    console.error('履歴月の読み込みに失敗:', error)
  );
}

function renderHistoryCalendar() {
  if (!dom.historyGrid) {
    return;
  }
  ensureHistoryMonthInitialized();
  updateHistoryMonthLabel();
  dom.historyGrid.innerHTML = '';
  const month = state.historyMonth;
  const offset = month.weekday % 7;
  const daysInMonth = month.daysInMonth;
  const totalCells = Math.ceil((offset + daysInMonth) / 7) * 7;
  const todayKey = state.todayKey;

  for (let index = 0; index < totalCells; index += 1) {
    const dayNumber = index - offset + 1;
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'history-day';
    if (dayNumber < 1 || dayNumber > daysInMonth) {
      cell.classList.add('history-day--placeholder');
      cell.disabled = true;
      dom.historyGrid.appendChild(cell);
      continue;
    }
    const dayDate = month.set({ day: dayNumber });
    const dayKey = dayDate.toFormat('yyyy-LL-dd');
    const dayData = state.historyDays[dayKey];
    const avgScoreValue = getDayAverageScore(dayData, 1);
    const thanksTotalValue =
      dayData && typeof dayData.thanksTotal === 'number'
        ? dayData.thanksTotal
        : null;
    const hasRecord = !!(
      dayData &&
      (dayData.scoreCount > 0 || (thanksTotalValue && thanksTotalValue > 0))
    );

    if (!dayData) {
      cell.classList.add('history-day--empty');
    }
    if (hasRecord) {
      cell.classList.add('history-day--recorded');
    }
    if (dayKey === todayKey) {
      cell.classList.add('history-day--today');
    }
    if (dayKey === state.historySelectedDay) {
      cell.classList.add('history-day--selected');
      cell.setAttribute('aria-pressed', 'true');
    } else {
      cell.setAttribute('aria-pressed', 'false');
    }
    if (dayKey === todayKey) {
      cell.setAttribute('aria-current', 'date');
    } else {
      cell.removeAttribute('aria-current');
    }
    const accessibleStatus = hasRecord ? '記録あり' : '記録なし';
    cell.setAttribute(
      'aria-label',
      `${dayDate.toFormat('M月d日')} ${accessibleStatus}`
    );
    const tooltipParts = [];
    if (dayKey === todayKey) {
      tooltipParts.push('今日');
    }
    if (avgScoreValue != null) {
      tooltipParts.push(`平均 ${avgScoreValue}`);
    }
    if (typeof thanksTotalValue === 'number') {
      tooltipParts.push(`ありがとう ${thanksTotalValue}`);
    }
    cell.title = tooltipParts.length
      ? tooltipParts.join(' / ')
      : accessibleStatus;
    cell.dataset.dayKey = dayKey;
    const indicator = hasRecord
      ? '<span class="history-day__indicator" aria-hidden="true"></span>'
      : '';
    cell.innerHTML = `
      <span class="history-day__number">${dayNumber}</span>
      ${indicator}
    `;
    cell.addEventListener('click', () => {
      selectHistoryDay(dayKey);
    });
    dom.historyGrid.appendChild(cell);
  }
}

function selectHistoryDay(dayKey) {
  if (!dayKey) return;
  state.historySelectedDay = dayKey;
  renderHistoryCalendar();
  renderHistoryDetail(dayKey);
  if (state.historyDayEntries[dayKey] === undefined) {
    fetchHistoryDayEntries(dayKey).catch((error) =>
      console.error('履歴詳細の取得に失敗:', error)
    );
  }
}

async function fetchHistoryDayEntries(dayKey) {
  if (!state.profile || !dayKey) {
    return;
  }
  if (state.historyDayEntries[dayKey] === 'loading') {
    return;
  }
  state.historyDayEntries[dayKey] = 'loading';
  renderHistoryDetail(dayKey);
  try {
    const entriesSnapshot = await getDocs(
      collection(doc(db, 'days', dayKey), 'entries')
    );
    state.historyDayEntries[dayKey] = entriesSnapshot.docs.map((docSnap) => ({
      id: docSnap.id,
      ...docSnap.data(),
    }));
  } catch (error) {
    state.historyDayEntries[dayKey] = [];
    showToast('履歴詳細の取得に失敗しました');
    if (state.historySelectedDay === dayKey) {
      renderHistoryDetail(dayKey);
    }
    throw error;
  }
  if (state.historySelectedDay === dayKey) {
    renderHistoryDetail(dayKey);
  }
}

function renderHistoryDetail(dayKey) {
  if (!dom.historyDetail) {
    return;
  }
  if (!dayKey) {
    if (dom.historyDetailDate) {
      dom.historyDetailDate.textContent = '日付を選択してください';
    }
    if (dom.historyDetailScore) {
      dom.historyDetailScore.textContent = '平均スコア: -';
    }
    if (dom.historyDetailThanks) {
      dom.historyDetailThanks.textContent = 'ありがとう合計: -';
    }
    if (dom.historyDetailThanksBreakdown) {
      dom.historyDetailThanksBreakdown.textContent = '祐介: - / 千里: -';
    }
    if (dom.historyDetailEntries) {
      dom.historyDetailEntries.innerHTML = '';
    }
    if (dom.historyOpenDay) {
      dom.historyOpenDay.disabled = true;
      delete dom.historyOpenDay.dataset.dayKey;
    }
    return;
  }
  const dayData = state.historyDays[dayKey];
  if (dom.historyDetailDate) {
    const label = dayData && dayData.displayDate ? dayData.displayDate : dayKey;
    dom.historyDetailDate.textContent = label;
  }
  const averageScoreValue = getDayAverageScore(dayData, 2);
  const averageScoreDisplay =
    averageScoreValue != null ? averageScoreValue : '-';
  if (dom.historyDetailScore) {
    dom.historyDetailScore.textContent = `平均スコア: ${averageScoreDisplay}`;
  }
  const thanksTotal =
    dayData && typeof dayData.thanksTotal === 'number'
      ? dayData.thanksTotal
      : '-';
  if (dom.historyDetailThanks) {
    dom.historyDetailThanks.textContent = `ありがとう合計: ${thanksTotal}`;
  }
  const breakdown = (dayData && dayData.thanksBreakdown) || {};
  const masterThanks =
    typeof breakdown.master === 'number' ? breakdown.master : '-';
  const chiiThanks = typeof breakdown.chii === 'number' ? breakdown.chii : '-';
  if (dom.historyDetailThanksBreakdown) {
    dom.historyDetailThanksBreakdown.textContent = `祐介: ${masterThanks} / 千里: ${chiiThanks}`;
  }
  if (dom.historyOpenDay) {
    dom.historyOpenDay.disabled = false;
    dom.historyOpenDay.dataset.dayKey = dayKey;
  }
  if (!dom.historyDetailEntries) {
    return;
  }

  const entries = state.historyDayEntries[dayKey];
  dom.historyDetailEntries.innerHTML = '';
  if (entries === 'loading') {
    const item = document.createElement('li');
    item.className = 'history-detail__empty';
    item.textContent = '読み込み中…';
    dom.historyDetailEntries.appendChild(item);
    return;
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    const item = document.createElement('li');
    item.className = 'history-detail__empty';
    item.textContent = 'まだ記録がありません。';
    dom.historyDetailEntries.appendChild(item);
    return;
  }

  const roleOrder = { master: 0, chii: 1 };
  entries
    .slice()
    .sort((a, b) => {
      const orderA = roleOrder[a.role] ?? 99;
      const orderB = roleOrder[b.role] ?? 99;
      return orderA - orderB;
    })
    .forEach((entry) => {
      const item = document.createElement('li');
      item.className = 'history-detail__entry';
      const header = document.createElement('div');
      header.className = 'history-detail__entry-header';

      const roleSpan = document.createElement('span');
      roleSpan.className = 'history-detail__entry-role';
      roleSpan.textContent = roleLabels[entry.role] || entry.role || 'ー';
      header.appendChild(roleSpan);

      if (typeof entry.score === 'number') {
        const scoreSpan = document.createElement('span');
        scoreSpan.className = 'history-detail__entry-score';
        scoreSpan.textContent = `評価: ${scoreLabel(entry.score)}`;
        header.appendChild(scoreSpan);
      }

      if (entry.updatedAt) {
        const updatedSpan = document.createElement('span');
        updatedSpan.className = 'history-detail__entry-updated';
        updatedSpan.textContent = `更新: ${formatDate(entry.updatedAt)}`;
        header.appendChild(updatedSpan);
      }

      item.appendChild(header);

      const note = document.createElement('p');
      note.className = 'history-detail__entry-note';
      note.textContent = entry.note ? entry.note : 'メモはありません。';
      item.appendChild(note);

      dom.historyDetailEntries.appendChild(item);
    });
}

function updateHistoryDayState(dayKey, data) {
  if (!dayKey) {
    return;
  }
  state.historyDays[dayKey] = { id: dayKey, ...data };
  if (
    state.historyMonth &&
    !state.historySelectedDay &&
    isDayInMonth(dayKey, state.historyMonth)
  ) {
    state.historySelectedDay = dayKey;
  }
  if (state.historyMonth && isDayInMonth(dayKey, state.historyMonth)) {
    renderHistoryCalendar();
  }
  if (state.historySelectedDay === dayKey) {
    renderHistoryDetail(dayKey);
  }
}

function getDayAverageScore(dayData, digits = 1) {
  if (!dayData) {
    return null;
  }
  if (typeof dayData.scoreAverage === 'number') {
    return Number(dayData.scoreAverage).toFixed(digits);
  }
  const count = typeof dayData.scoreCount === 'number' ? dayData.scoreCount : 0;
  const sum = typeof dayData.scoreSum === 'number' ? dayData.scoreSum : 0;
  if (!count) {
    return null;
  }
  return (sum / count).toFixed(digits);
}

function scoreLabel(score) {
  const option = findScoreOptionByValue(score);
  return option ? option.label : '-';
}

async function handleAgreementSubmit(event) {
  event.preventDefault();
  const formData = new FormData(dom.modalForm);
  const rawTitle = formData.get('title');
  const rawBody = formData.get('body');
  const title = rawTitle == null ? '' : String(rawTitle).trim();
  const body = rawBody == null ? '' : String(rawBody).trim();
  if (!title) {
    showToast('タイトルを入力してください');
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
  editingAgreementId = agreement && agreement.id ? agreement.id : null;
  dom.modalTitle.textContent =
    mode === MODAL_MODE.CREATE ? '新しい決め事' : '決め事を編集';
  if (agreement) {
    dom.modalForm.title.value = agreement.title || '';
    dom.modalForm.body.value = agreement.body || '';
  } else {
    dom.modalForm.reset();
  }
  toggleModal(true);
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
  console.log('決め事ハンドラーを設定');

  if (!dom.addAgreement) {
    console.error('決め事追加ボタンが見つかりません');
    return;
  }

  dom.addAgreement.addEventListener('click', () =>
    openAgreementModal(MODAL_MODE.CREATE)
  );
  dom.modalCancel.addEventListener('click', () => toggleModal(false));
  dom.modalForm.addEventListener('submit', handleAgreementSubmit);
  dom.modalDelete.addEventListener('click', () => {
    if (!editingAgreementId) return;
    if (!state.profile || state.profile.role !== 'master') {
      showToast('削除はマスターのみ可能です');
      return;
    }
    if (window.confirm('決め事を削除しますか？')) {
      archiveAgreement(editingAgreementId).then(() => {
        toggleModal(false);
      });
    }
  });
  dom.agreementList.addEventListener('pointerdown', (event) => {
    const item = event.target.closest('.agreement-item');
    if (!item) return;
    agreementPressTargetId = item.dataset.id;
    agreementPressTimer = window.setTimeout(() => {
      agreementPressTimer = null;
      const agreement = findAgreementById(agreementPressTargetId);
      if (agreement) {
        openAgreementModal(MODAL_MODE.EDIT, agreement);
      }
    }, 550);
  });
  const cancelAgreementPress = () => {
    if (agreementPressTimer) {
      clearTimeout(agreementPressTimer);
      agreementPressTimer = null;
      agreementPressTargetId = null;
    }
  };
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((type) => {
    dom.agreementList.addEventListener(type, cancelAgreementPress);
  });
  dom.agreementList.addEventListener('pointermove', (event) => {
    if (!agreementPressTimer) return;
    const item = event.target.closest('.agreement-item');
    if (!item || item.dataset.id !== agreementPressTargetId) {
      cancelAgreementPress();
    }
  });
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
  await ensureScoreBreakdown(days);
  applyStats(days);
  updateChart(days.slice().reverse());
}

function updateStatsFromDayDoc(dayKey, dayData) {
  if (hasValidScoreBreakdown(dayData)) {
    scoreBreakdownCache.set(dayKey, dayData.scoreBreakdown);
  }
  if (dayKey === state.todayKey) {
    const todayRoleStats = getRoleStatsFromDay(dayData || {});
    const summary = summarizeRoleStats(todayRoleStats);
    dom.statTodayScore.textContent = summary.scoreCount
      ? (summary.scoreSum / summary.scoreCount).toFixed(2)
      : '-';
    const { sent, received } = getThanksSplitFromBreakdown(
      dayData && dayData.thanksBreakdown
    );
    renderThanksStat(
      dom.statTodayThanksSent,
      dom.statTodayThanksReceived,
      sent,
      received
    );
    updatePersonStatsForPeriod('today', todayRoleStats, { hasData: true });
  }
}

function createEmptyRoleStats() {
  const stats = {};
  ROLES.forEach((role) => {
    stats[role] = { scoreSum: 0, scoreCount: 0, thanks: 0 };
  });
  return stats;
}

function getScoreBreakdownFromDay(day) {
  const breakdown = {};
  ROLES.forEach((role) => {
    const raw =
      day && day.scoreBreakdown && typeof day.scoreBreakdown === 'object'
        ? day.scoreBreakdown[role]
        : null;
    const sum = raw && typeof raw.sum === 'number' ? raw.sum : 0;
    const count = raw && typeof raw.count === 'number' ? raw.count : 0;
    const average =
      raw && typeof raw.average === 'number'
        ? raw.average
        : count > 0
          ? sum / count
          : null;
    breakdown[role] = { sum, count, average };
  });
  return breakdown;
}

function getThanksBreakdownFromDay(day) {
  const breakdown = {};
  ROLES.forEach((role) => {
    const raw =
      day && day.thanksBreakdown && typeof day.thanksBreakdown === 'object'
        ? day.thanksBreakdown[role]
        : null;
    breakdown[role] = typeof raw === 'number' ? raw : 0;
  });
  return breakdown;
}

function getRoleStatsFromDay(day) {
  const stats = createEmptyRoleStats();
  const score = getScoreBreakdownFromDay(day || {});
  const thanks = getThanksBreakdownFromDay(day || {});
  ROLES.forEach((role) => {
    stats[role].scoreSum = score[role].sum;
    stats[role].scoreCount = score[role].count;
    stats[role].thanks = thanks[role];
  });
  return stats;
}

function addRoleStats(target, addition) {
  ROLES.forEach((role) => {
    const source = addition[role] || {};
    target[role].scoreSum += source.scoreSum || 0;
    target[role].scoreCount += source.scoreCount || 0;
    target[role].thanks += source.thanks || 0;
  });
}

function summarizeRoleStats(statsByRole) {
  return ROLES.reduce(
    (acc, role) => {
      const stats = statsByRole[role] || {};
      acc.scoreSum += stats.scoreSum || 0;
      acc.scoreCount += stats.scoreCount || 0;
      acc.thanks += stats.thanks || 0;
      return acc;
    },
    { scoreSum: 0, scoreCount: 0, thanks: 0 }
  );
}

function updatePersonStatsForPeriod(period, statsByRole, options = {}) {
  const hasData = options.hasData !== undefined ? options.hasData : true;
  ROLES.forEach((role) => {
    const targets = dom.statPerson && dom.statPerson[role];
    if (!targets) {
      return;
    }
    const scoreNode = targets[`${period}Score`];
    const thanksNode = targets[`${period}Thanks`];
    const roleStats = statsByRole[role] || {
      scoreSum: 0,
      scoreCount: 0,
      thanks: 0,
    };
    if (scoreNode) {
      if (!hasData) {
        scoreNode.textContent = '-';
      } else if (roleStats.scoreCount) {
        scoreNode.textContent = (
          roleStats.scoreSum / roleStats.scoreCount
        ).toFixed(2);
      } else {
        scoreNode.textContent = '-';
      }
    }
    if (thanksNode) {
      thanksNode.textContent = hasData
        ? `ありがとう ${roleStats.thanks || 0}`
        : 'ありがとう -';
    }
  });
}

function hasValidScoreBreakdown(day) {
  if (!day || typeof day.scoreBreakdown !== 'object') {
    return false;
  }
  return ROLES.every((role) => {
    const data = day.scoreBreakdown[role];
    if (!data || typeof data !== 'object') {
      return false;
    }
    return typeof data.sum === 'number' && typeof data.count === 'number';
  });
}

async function ensureScoreBreakdown(days) {
  await Promise.all(
    days.map(async (day) => {
      if (!day || !day.id) {
        return;
      }
      if (hasValidScoreBreakdown(day)) {
        scoreBreakdownCache.set(day.id, day.scoreBreakdown);
        return;
      }
      const cached = scoreBreakdownCache.get(day.id);
      if (cached) {
        day.scoreBreakdown = cached;
        return;
      }
      const entriesSnap = await getDocs(
        collection(db, 'days', day.id, 'entries')
      );
      const roleStats = createEmptyRoleStats();
      entriesSnap.forEach((entrySnap) => {
        const data = entrySnap.data();
        const role = data && data.role;
        const score = data && data.score;
        if (
          (role === 'master' || role === 'chii') &&
          typeof score === 'number'
        ) {
          roleStats[role].scoreSum += score;
          roleStats[role].scoreCount += 1;
        }
      });
      const breakdown = {
        master: {
          sum: roleStats.master.scoreSum,
          count: roleStats.master.scoreCount,
          average: roleStats.master.scoreCount
            ? roleStats.master.scoreSum / roleStats.master.scoreCount
            : null,
        },
        chii: {
          sum: roleStats.chii.scoreSum,
          count: roleStats.chii.scoreCount,
          average: roleStats.chii.scoreCount
            ? roleStats.chii.scoreSum / roleStats.chii.scoreCount
            : null,
        },
      };
      day.scoreBreakdown = breakdown;
      scoreBreakdownCache.set(day.id, breakdown);
    })
  );
}

function applyStats(days) {
  const now = DateTime.now().setZone(APP_SETTINGS.timezone, {
    keepLocalTime: false,
  });
  const weekKey = getDateInfo().weekKey;
  const monthKey = now.toFormat('yyyy-LL');
  const todayStats = createEmptyRoleStats();
  const weekStats = createEmptyRoleStats();
  const monthStats = createEmptyRoleStats();
  let todaySplit = { sent: 0, received: 0 };
  let hasToday = false;
  let weekThanksSent = 0;
  let weekThanksReceived = 0;
  let monthThanksSent = 0;
  let monthThanksReceived = 0;
  days.forEach((day) => {
    if (!day) {
      return;
    }
    const roleStats = getRoleStatsFromDay(day);
    if (day.id === state.todayKey) {
      addRoleStats(todayStats, roleStats);
      hasToday = true;
      todaySplit = getThanksSplitFromBreakdown(day.thanksBreakdown);
    }
    if (day.weekKey === weekKey) {
      addRoleStats(weekStats, roleStats);
      const { sent, received } = getThanksSplitFromBreakdown(
        day.thanksBreakdown
      );
      weekThanksSent += sent;
      weekThanksReceived += received;
    }
    if (typeof day.id === 'string' && day.id.indexOf(monthKey) === 0) {
      addRoleStats(monthStats, roleStats);
      const { sent, received } = getThanksSplitFromBreakdown(
        day.thanksBreakdown
      );
      monthThanksSent += sent;
      monthThanksReceived += received;
    }
  });

  const todaySummary = summarizeRoleStats(todayStats);
  if (hasToday) {
    dom.statTodayScore.textContent = todaySummary.scoreCount
      ? (todaySummary.scoreSum / todaySummary.scoreCount).toFixed(2)
      : '-';
    renderThanksStat(
      dom.statTodayThanksSent,
      dom.statTodayThanksReceived,
      todaySplit.sent,
      todaySplit.received
    );
  } else {
    dom.statTodayScore.textContent = '-';
    renderThanksStat(
      dom.statTodayThanksSent,
      dom.statTodayThanksReceived,
      0,
      0
    );
  }

  const weekSummary = summarizeRoleStats(weekStats);
  dom.statWeekScore.textContent = weekSummary.scoreCount
    ? (weekSummary.scoreSum / weekSummary.scoreCount).toFixed(2)
    : '-';
  renderThanksStat(
    dom.statWeekThanksSent,
    dom.statWeekThanksReceived,
    weekThanksSent,
    weekThanksReceived
  );

  const monthSummary = summarizeRoleStats(monthStats);
  dom.statMonthScore.textContent = monthSummary.scoreCount
    ? (monthSummary.scoreSum / monthSummary.scoreCount).toFixed(2)
    : '-';
  renderThanksStat(
    dom.statMonthThanksSent,
    dom.statMonthThanksReceived,
    monthThanksSent,
    monthThanksReceived
  );

  updatePersonStatsForPeriod('today', todayStats, { hasData: hasToday });
  updatePersonStatsForPeriod('week', weekStats);
  updatePersonStatsForPeriod('month', monthStats);
}

function updateChart(days) {
  if (typeof Chart === 'undefined') {
    return;
  }
  const labels = days.map((day) => day.displayDate || day.id);
  const masterScores = [];
  const chiiScores = [];
  const masterThanks = [];
  const chiiThanks = [];
  days.forEach((day) => {
    const scoreBreakdown = getScoreBreakdownFromDay(day || {});
    const thanksBreakdown = getThanksBreakdownFromDay(day || {});
    const masterAverage = scoreBreakdown.master.average;
    const chiiAverage = scoreBreakdown.chii.average;
    masterScores.push(
      typeof masterAverage === 'number'
        ? Number(masterAverage.toFixed(2))
        : null
    );
    chiiScores.push(
      typeof chiiAverage === 'number' ? Number(chiiAverage.toFixed(2)) : null
    );
    masterThanks.push(thanksBreakdown.master || 0);
    chiiThanks.push(thanksBreakdown.chii || 0);
  });
  if (state.chart) {
    state.chart.destroy();
  }
  state.chart = new Chart(dom.trendCanvas.getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: '祐介のスコア',
          data: masterScores,
          borderColor: ROLE_CHART_STYLE.master.scoreBorder,
          backgroundColor: ROLE_CHART_STYLE.master.scoreBackground,
          tension: 0.3,
          spanGaps: true,
          yAxisID: 'y',
          order: 1,
        },
        {
          label: '千里のスコア',
          data: chiiScores,
          borderColor: ROLE_CHART_STYLE.chii.scoreBorder,
          backgroundColor: ROLE_CHART_STYLE.chii.scoreBackground,
          tension: 0.3,
          spanGaps: true,
          yAxisID: 'y',
          order: 1,
        },
        {
          label: '祐介のありがとう',
          data: masterThanks,
          borderColor: ROLE_CHART_STYLE.master.thanksBorder,
          backgroundColor: ROLE_CHART_STYLE.master.thanksBackground,
          type: 'bar',
          yAxisID: 'y1',
          stack: 'thanks',
          order: 2,
          borderWidth: 1,
        },
        {
          label: '千里のありがとう',
          data: chiiThanks,
          borderColor: ROLE_CHART_STYLE.chii.thanksBorder,
          backgroundColor: ROLE_CHART_STYLE.chii.thanksBackground,
          type: 'bar',
          yAxisID: 'y1',
          stack: 'thanks',
          order: 2,
          borderWidth: 1,
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
          stacked: true,
          beginAtZero: true,
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
    console.log('Googleログインを開始');
    const provider = new GoogleAuthProvider();
    try {
      const result = await signInWithPopup(auth, provider);
      console.log('ログイン成功:', result.user.email);
    } catch (error) {
      console.error('ログインエラー:', error);
      showToast('ログインに失敗しました');
    }
  });
  dom.logoutButton.addEventListener('click', () => {
    signOut(auth);
  });
  dom.thanksButton.addEventListener('click', handleThanksClick);
  dom.jumpToday.addEventListener('click', () => {
    if (state.todayKey) {
      setActiveDay(state.todayKey);
    }
    setActiveView('today');
  });
  if (dom.historyPrevMonth) {
    dom.historyPrevMonth.addEventListener('click', () =>
      changeHistoryMonth(-1)
    );
  }
  if (dom.historyNextMonth) {
    dom.historyNextMonth.addEventListener('click', () => changeHistoryMonth(1));
  }
  setupViewSwipe();
  if (dom.historyOpenDay) {
    dom.historyOpenDay.addEventListener('click', () => {
      const dayKey = dom.historyOpenDay.dataset.dayKey;
      if (!dayKey) {
        return;
      }
      setActiveDay(dayKey)
        .then(() => {
          setActiveView('today');
          showToast(`${dayKey} の詳細を開きました`);
        })
        .catch((error) => {
          console.error('日付の切り替えに失敗:', error);
          showToast('日付の切り替えに失敗しました');
        });
    });
  }
  forEachNode(dom.navButtons, (button) => {
    if (!button) {
      return;
    }
    if (button.classList && button.classList.contains('hidden')) {
      button.classList.remove('hidden');
    }
    button.addEventListener('click', () => {
      const view = button.dataset
        ? button.dataset.view
        : button.getAttribute('data-view');
      if (view) {
        setActiveView(view);
      }
    });
  });
  if (dom.viewSelect) {
    dom.viewSelect.addEventListener('change', (event) => {
      const target = event.target;
      if (!target) {
        return;
      }
      const view = target.value;
      if (view) {
        setActiveView(view);
      }
    });
  }
  if (dom.viewSwitcher) {
    let shouldShowViewSelect = true;
    const supportsGrid =
      typeof CSS !== 'undefined' &&
      CSS &&
      typeof CSS.supports === 'function' &&
      CSS.supports('display', 'grid');
    if (supportsGrid) {
      shouldShowViewSelect = false;
    }
    if (!dom.navButtons || dom.navButtons.length < 4) {
      shouldShowViewSelect = true;
    }
    if (shouldShowViewSelect) {
      dom.viewSwitcher.classList.remove('view-switcher--hidden');
    }
  }
  setupAgreementHandlers();
  dom.modalBackdrop.addEventListener('click', (event) => {
    if (event.target === dom.modalBackdrop) {
      toggleModal(false);
    }
  });
}

async function bootstrap() {
  try {
    console.log('アプリケーション起動中...');

    // DOMが完全に読み込まれているか確認
    if (document.readyState === 'loading') {
      await new Promise((resolve) => {
        document.addEventListener('DOMContentLoaded', resolve, { once: true });
      });
    }

    bindGlobalEvents();
    await initializeAutoUpdateMonitor();
    setActiveView('today');
    await setPersistence(auth, browserLocalPersistence);
    onAuthStateChanged(auth, handleAuthState);

    console.log('アプリケーション起動完了');
  } catch (error) {
    console.error('bootstrap内でエラー:', error);
    throw error;
  }
}

// アプリケーション起動
bootstrap().catch((error) => {
  console.error('アプリ初期化中にエラーが発生しました:', error);
  console.error('エラーの詳細:', error.message, error.stack);

  // より詳細なエラーメッセージを表示
  let errorMessage = 'アプリの初期化に失敗しました';
  if (error.message) {
    if (error.message.indexOf('luxon') !== -1) {
      errorMessage = 'Luxonライブラリの読み込みエラー';
    } else if (error.message.indexOf('Firebase') !== -1) {
      errorMessage = 'Firebase初期化エラー';
    } else if (error.message.indexOf('Network') !== -1) {
      errorMessage = 'ネットワークエラー';
    }
    errorMessage += `: ${error.message}`;
  }
  showToast(errorMessage);
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .getRegistrations()
      .then((registrations) => {
        for (let index = 0; index < registrations.length; index += 1) {
          const registration = registrations[index];
          if (registration && typeof registration.unregister === 'function') {
            registration.unregister();
          }
        }
      })
      .catch(() => {});
  });
}
