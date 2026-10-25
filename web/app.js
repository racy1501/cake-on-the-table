let slices = [];
let state = { round: 1, currentRound: 1, eaten: [], plate: [], remaining: 0, total: 0, cooldownSeconds: 0 };
let config = { texts: {} };
let boardRound = 1;
let boardPlate = [];
let boardNavigation = { previousRound: null, nextRound: null, latestRound: 1 };
let stateReady = false;
let toolsRegistered = false;
let busy = false;
let visitorId = '';
let guestName = '';
let guestNamed = false;
let lastClaim = null;
let lastTopRecord = null;
let cooldownLeft = 0;
let noteCloseTimer = 0;

const $ = (selector) => document.querySelector(selector);
const cake = $('#cake');
const flavorList = $('#flavor-list');
const remainingCount = $('#remaining-count');
const totalCount = $('#total-count');
const roundNumber = $('#round-number');
const roundBadgeNumber = $('#round-badge-number');
const statusLine = $('#status-line');
const boardList = $('#records-list');
const boardRoundLabel = $('#board-round');
const previousPageButton = $('#previous-page');
const nextPageButton = $('#next-page');
const currentPlateButton = $('#current-plate');
const nameStage = $('#name-stage');
const nameForm = $('#name-form');
const guestNameInput = $('#guest-name');
const nameError = $('#name-error');
const noteStage = $('#note-stage');
const noteText = $('#note-text');
const noteSource = $('#note-source');
const noteFlavor = $('#note-flavor');
const noteAlias = $('#note-alias');
const noteClose = $('#note-close');
const messageForm = $('#message-form');
const guestMessageInput = $('#guest-message');
const messageCount = $('#message-count');
const messageStatus = $('#message-status');
const renameButton = $('#rename-button');

try {
  const savedName = localStorage.getItem('cake-guest-name-v1');
  if (savedName !== null) {
    guestName = savedName.trim();
    guestNamed = true;
  }
} catch {}
nameStage.hidden = guestNamed;

function canPick() {
  return stateReady && guestNamed && cooldownLeft <= 0 && !busy;
}

function syncCooldown() {
  const fromServer = Number(state.cooldownSeconds) || 0;
  if (fromServer > cooldownLeft) cooldownLeft = fromServer;
}

function applyConfig() {
  const messageMaxLength = Number(config.limits?.messageMaxLength) || 500;
  document.title = config.siteTitle || '桌上有蛋糕';
  $('#site-title').textContent = config.siteTitle || '桌上有蛋糕';
  $('#site-subtitle').textContent = config.siteSubtitle || 'A TINY CAKE FOR ANYONE';
  $('#site-intro').textContent = config.intro || '';
  $('#records-heading').textContent = config.texts?.boardTitle || '盘子记得谁来过';
  $('#board-sub').textContent = config.texts?.boardSub || '默认只显示这一盘。想看以前的，翻一页。';
  $('#name-title').textContent = config.texts?.nameCardTitle || '欢迎来吃蛋糕';
  $('#name-help').textContent = `${config.texts?.nameHelp || '留空则随机生成一个编号。'} 这个名字会出现在公开记录里。`;
  $('#note-sign').textContent = config.texts?.noteSign || '— 蛋糕暂时不肯解释';
  guestMessageInput.maxLength = messageMaxLength;
  messageCount.textContent = `${guestMessageInput.value.length} / ${messageMaxLength}`;
  cake.setAttribute('aria-label', `蛋糕桌上一只切成 ${slices.length} 块的蛋糕`);
}

function polarPoint(cx, cy, radius, angleDegrees) {
  const angle = (angleDegrees * Math.PI) / 180;
  return { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) };
}

function wedgePath(startAngle, endAngle) {
  const start = polarPoint(150, 150, 135, startAngle);
  const end = polarPoint(150, 150, 135, endAngle);
  const largeArc = endAngle - startAngle > 180 ? 1 : 0;
  return `M 150 150 L ${start.x.toFixed(2)} ${start.y.toFixed(2)} A 135 135 0 ${largeArc} 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)} Z`;
}

function makeSvgElement(tag, attributes = {}) {
  const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
  Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, String(value)));
  return element;
}

function makeCakeSvg() {
  const svg = makeSvgElement('svg', { viewBox: '0 0 300 300', class: 'cake-svg' });
  svg.append(makeSvgElement('circle', { cx: 150, cy: 150, r: 138, fill: '#d7a998', opacity: '.45' }));
  const sliceAngle = 360 / Math.max(1, slices.length);

  slices.forEach((slice, index) => {
    const eaten = state.eaten.includes(slice.id);
    const startAngle = -90 + index * sliceAngle;
    const endAngle = startAngle + sliceAngle;
    const midAngle = startAngle + sliceAngle / 2;
    const garnish = polarPoint(150, 150, 92, midAngle);
    const creamInset = Math.min(5, sliceAngle / 5);
    const creamStart = polarPoint(150, 150, 119, startAngle + creamInset);
    const creamEnd = polarPoint(150, 150, 119, endAngle - creamInset);
    const direction = polarPoint(0, 0, 32, midAngle);
    const group = makeSvgElement('g', {
      class: 'slice',
      role: 'button',
      tabindex: canPick() && !eaten ? 0 : -1,
      'aria-label': `${index + 1} 号蛋糕：${slice.name}${eaten ? '，已经吃掉' : ''}`,
      'aria-disabled': !canPick() || eaten ? 'true' : 'false',
      'data-slice-id': slice.id,
    });
    group.style.setProperty('--icing-color', slice.icing);
    group.style.setProperty('--berry-color', slice.berry);
    group.style.setProperty('--take-x', `${direction.x.toFixed(1)}px`);
    group.style.setProperty('--take-y', `${direction.y.toFixed(1)}px`);
    if (eaten) group.style.opacity = '0';

    group.append(makeSvgElement('path', { d: wedgePath(startAngle, endAngle), fill: slice.cake, class: 'slice-path' }));
    group.append(makeSvgElement('path', {
      d: `M ${creamStart.x.toFixed(2)} ${creamStart.y.toFixed(2)} A 119 119 0 0 1 ${creamEnd.x.toFixed(2)} ${creamEnd.y.toFixed(2)}`,
      class: 'slice-icing',
    }));
    group.append(makeSvgElement('circle', { cx: garnish.x, cy: garnish.y, r: 8, class: 'slice-dot' }));
    group.append(makeSvgElement('circle', { cx: garnish.x + 5, cy: garnish.y - 6, r: 4, class: 'slice-berry' }));
    group.append(makeSvgElement('ellipse', {
      cx: garnish.x + 9,
      cy: garnish.y - 11,
      rx: 2.5,
      ry: 5,
      transform: `rotate(${midAngle + 35} ${garnish.x + 9} ${garnish.y - 11})`,
      class: 'slice-leaf',
    }));

    if (canPick() && !eaten) {
      group.addEventListener('click', () => void eatSlice(slice.id).catch(showError));
      group.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          void eatSlice(slice.id).catch(showError);
        }
      });
    }
    svg.append(group);
  });
  return svg;
}

function renderBoard() {
  boardRoundLabel.textContent = `第 ${boardRound} 盘`;
  boardList.replaceChildren();
  if (!boardPlate.length) {
    const empty = document.createElement('li');
    empty.className = 'board-empty';
    empty.textContent = config.texts?.emptyBoard || '还没有人动叉子。';
    boardList.append(empty);
  } else {
    boardPlate.forEach((record) => {
      const item = document.createElement('li');
      item.className = 'board-item';
      const head = document.createElement('div');
      head.className = 'board-head';
      const name = document.createElement('span');
      name.className = 'board-name';
      name.textContent = record.eaterName;
      const action = document.createElement('span');
      action.className = 'board-action';
      action.append('吃掉了 ');
      const flavor = document.createElement('em');
      flavor.textContent = record.sliceName || '一块神秘蛋糕';
      action.append(flavor);
      const meta = document.createElement('span');
      meta.className = 'board-meta';
      const stamp = document.createElement('time');
      stamp.dateTime = record.eatenAt;
      stamp.textContent = new Date(record.eatenAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      meta.append(stamp);
      head.append(name, action, meta);
      item.append(head);
      if (record.message) {
        const message = document.createElement('p');
        message.className = 'board-message';
        message.textContent = record.message;
        item.append(message);
      }
      boardList.append(item);
    });
  }

  if (boardRound === state.round) {
    const topRecord = boardPlate[0];
    const topKey = topRecord ? `${topRecord.round}:${topRecord.sliceId}` : null;
    if (lastTopRecord !== null && topKey && topKey !== lastTopRecord) {
      boardList.firstElementChild?.classList.add('is-fresh');
    }
    lastTopRecord = topKey;
  }
  previousPageButton.disabled = boardNavigation.previousRound === null;
  nextPageButton.disabled = boardNavigation.nextRound === null;
  currentPlateButton.hidden = boardRound === state.round;
}

function render() {
  cake.replaceChildren(makeCakeSvg());
  cake.classList.toggle('is-loading', !stateReady);
  flavorList.replaceChildren();
  slices.forEach((slice, index) => {
    const item = document.createElement('li');
    item.textContent = `${index + 1}. ${slice.name}`;
    item.style.setProperty('--dot', slice.cake);
    if (state.eaten.includes(slice.id)) item.classList.add('is-eaten');
    flavorList.append(item);
  });
  remainingCount.textContent = String(state.remaining);
  totalCount.textContent = `/${state.total}`;
  roundNumber.textContent = String(state.round);
  roundBadgeNumber.textContent = String(state.round);
  renderBoard();

  if (stateReady && !busy) {
    if (cooldownLeft > 0) statusLine.textContent = `刚吃过一块。${cooldownLeft} 秒后可以再挑。`;
    else if (state.remaining === 1) statusLine.textContent = '只剩最后一块了。吃掉它，就会端上新蛋糕。';
    else statusLine.textContent = config.texts?.hint || '挑一块吧。';
  }
}

function showNote(slice, note, replenished, messageAlreadySaved = false, alias = '') {
  window.clearTimeout(noteCloseTimer);
  noteFlavor.textContent = replenished ? `你吃掉了最后一块 · ${slice.name}` : `你吃掉了 · ${slice.name}`;
  const cut = note.lastIndexOf('——《');
  const main = cut > 0 ? note.slice(0, cut) : note;
  const source = cut > 0 ? note.slice(cut + 2) : '';
  noteText.textContent = replenished ? `${main} 新蛋糕也已经端上来了。` : main;
  noteText.style.fontSize = main.length > 30 ? 'clamp(18px, 3vw, 24px)' : '';
  noteSource.textContent = source;
  noteSource.hidden = !source;
  noteAlias.replaceChildren();
  if (alias) {
    const tag = document.createElement('em');
    tag.textContent = alias;
    noteAlias.append('你是 ', tag);
  }
  noteAlias.hidden = !alias;
  noteStage.hidden = false;
  guestMessageInput.value = '';
  messageCount.textContent = `0 / ${guestMessageInput.maxLength}`;
  messageStatus.textContent = messageAlreadySaved ? '你的留言也已经留在盘边了。' : '';
  guestMessageInput.disabled = messageAlreadySaved;
  messageForm.querySelector('button').disabled = messageAlreadySaved;
  document.body.style.overflow = 'hidden';
  requestAnimationFrame(() => noteClose.focus());
}

function hideNote() {
  window.clearTimeout(noteCloseTimer);
  noteStage.hidden = true;
  document.body.style.overflow = '';
}

function showError(error) {
  busy = false;
  render();
  statusLine.textContent = error instanceof Error ? error.message : '蛋糕刚才晃了一下，请再试试。';
}

async function fetchJson(url, options) {
  const response = await fetch(url, { cache: 'no-store', ...options });
  const payload = await response.json();
  return { response, payload };
}

async function loadState({ quiet = false } = {}) {
  if (!quiet) statusLine.textContent = '正在看看蛋糕还剩几块……';
  const oldCurrent = state.currentRound;
  const boardWasCurrent = !stateReady || boardRound === oldCurrent;
  const { response, payload } = await fetchJson('/api/cake');
  if (!response.ok) throw new Error('暂时看不清盘子里还剩几块，请稍后再来。');
  state = payload;
  slices = state.slices;
  config = state.config || config;
  if (state.visitorId) visitorId = state.visitorId;
  if (boardWasCurrent) {
    boardRound = state.round;
    boardPlate = state.plate;
    boardNavigation = state.navigation;
  }
  stateReady = true;
  syncCooldown();
  applyConfig();
  render();
  registerAgentTools();
  return state;
}

async function loadPlate(round) {
  const { response, payload } = await fetchJson(`/api/cake?round=${encodeURIComponent(round)}`);
  if (!response.ok) throw new Error('这一盘暂时翻不到。');
  boardRound = payload.round;
  boardPlate = payload.plate;
  boardNavigation = payload.navigation;
  renderBoard();
  return payload;
}

async function eatSlice(sliceId, options = {}) {
  if (!stateReady || busy) throw new Error('蛋糕还没摆稳，请等一下。');
  if (cooldownLeft > 0) throw new Error(`刚吃过一块，${cooldownLeft} 秒后才能再挑。`);
  const eaterName = (options.eaterName ?? guestName).trim().replace(/\s+/g, ' ');
  const message = (options.message ?? '').trim();
  if (eaterName.length > 24) throw new Error('名字最多 24 个字。');
  if (message.length > guestMessageInput.maxLength) throw new Error(`留言最多 ${guestMessageInput.maxLength} 个字符。`);
  const anonymous = !eaterName;
  const slice = slices.find((item) => item.id === sliceId);
  if (!slice) throw new Error('没有这块蛋糕。');
  if (state.eaten.includes(sliceId)) throw new Error('这块刚刚被别人吃掉了，请换一块。');

  busy = true;
  const claimRound = state.round;
  statusLine.textContent = `正在拿走${slice.name}……`;
  const { response, payload } = await fetchJson('/api/cake', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ visitorId, sliceId, round: claimRound, eaterName, message }),
  });

  if (!response.ok) {
    if (payload.state) {
      state = payload.state;
      slices = state.slices;
      boardRound = state.round;
      boardPlate = state.plate;
      boardNavigation = state.navigation;
      stateReady = true;
      syncCooldown();
    }
    busy = false;
    render();
    if (payload.error === 'too_fast') throw new Error(`刚吃过一块，${payload.retryAfterSeconds || '几'} 秒后再挑吧。`);
    if (payload.error === 'already_eaten') throw new Error('慢了一步，这块刚被别人吃掉。再挑一块吧。');
    throw new Error('蛋糕已经换了新的一盘，请重新挑一块。');
  }

  cake.querySelector(`[data-slice-id="${CSS.escape(sliceId)}"]`)?.classList.add('eaten');
  await new Promise((resolve) => window.setTimeout(resolve, 520));
  state = payload.state;
  slices = state.slices;
  boardRound = state.round;
  boardPlate = state.plate;
  boardNavigation = state.navigation;
  syncCooldown();
  lastClaim = { claimToken: payload.claimToken };
  if (anonymous && payload.eaterName) {
    guestName = payload.eaterName;
    try { localStorage.setItem('cake-guest-name-v1', guestName); } catch {}
  }
  busy = false;
  render();
  showNote(slice, payload.note, payload.replenished, Boolean(message), anonymous ? payload.eaterName || '' : '');
  return {
    slice: payload.sliceName || slice.name,
    note: payload.note,
    replenished: payload.replenished,
    replayed: payload.replayed,
    round: state.round,
    remaining: state.remaining,
  };
}

nameForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const name = guestNameInput.value.trim().replace(/\s+/g, ' ');
  if (name.length > 24) {
    nameError.textContent = '名字最多 24 个字。';
    return;
  }
  guestName = name;
  guestNamed = true;
  try { localStorage.setItem('cake-guest-name-v1', guestName); } catch {}
  nameError.textContent = '';
  nameStage.hidden = true;
  render();
  statusLine.textContent = guestName ? `${guestName}，挑一块你喜欢的吧。` : '挑一块你喜欢的吧。';
});

renameButton.addEventListener('click', () => {
  guestName = '';
  guestNamed = false;
  try { localStorage.removeItem('cake-guest-name-v1'); } catch {}
  guestNameInput.value = '';
  nameError.textContent = '';
  nameStage.hidden = false;
  render();
  requestAnimationFrame(() => guestNameInput.focus());
});

messageForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = guestMessageInput.value.trim();
  if (!message) {
    messageStatus.textContent = '不想写也没关系，直接收起纸条就好。';
    return;
  }
  if (!lastClaim) {
    messageStatus.textContent = '这张纸条的留言时间已经过去了。';
    return;
  }
  const { response, payload } = await fetchJson('/api/cake', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ claimToken: lastClaim.claimToken, message }),
  });
  if (!response.ok) {
    messageStatus.textContent = payload.error === 'message_already_set' ? '这条记录已经有留言了。' : '这句话刚才没能留下，请再试一次。';
    return;
  }
  state = payload.state;
  boardRound = state.round;
  boardPlate = state.plate;
  boardNavigation = state.navigation;
  render();
  messageStatus.textContent = '已经贴到留言板上了。';
  guestMessageInput.disabled = true;
  messageForm.querySelector('button').disabled = true;
  window.clearTimeout(noteCloseTimer);
  noteCloseTimer = window.setTimeout(hideNote, 1800);
});

guestMessageInput.addEventListener('input', () => {
  messageCount.textContent = `${guestMessageInput.value.length} / ${guestMessageInput.maxLength}`;
});

previousPageButton.addEventListener('click', () => {
  if (boardNavigation.previousRound !== null) void loadPlate(boardNavigation.previousRound).catch(showError);
});

nextPageButton.addEventListener('click', () => {
  if (boardNavigation.nextRound !== null) void loadPlate(boardNavigation.nextRound).catch(showError);
});

currentPlateButton.addEventListener('click', () => {
  boardRound = state.round;
  boardPlate = state.plate;
  boardNavigation = state.navigation;
  renderBoard();
});

noteClose.addEventListener('click', hideNote);
noteStage.querySelector('.note-backdrop').addEventListener('click', hideNote);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !noteStage.hidden) hideNote();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !busy) void loadState({ quiet: true }).catch(showError);
});

window.setInterval(() => {
  if (!busy && noteStage.hidden) void loadState({ quiet: true }).catch(() => {});
}, 15000);

window.setInterval(() => {
  if (cooldownLeft <= 0) return;
  cooldownLeft -= 1;
  if (cooldownLeft <= 0) {
    void loadState({ quiet: true }).catch(() => {});
    return;
  }
  if (stateReady && !busy) statusLine.textContent = `刚吃过一块。${cooldownLeft} 秒后可以再挑。`;
}, 1000);

function registerAgentTools() {
  if (toolsRegistered) return;
  const registry = document.modelContext;
  if (!registry || typeof registry.registerTool !== 'function') return;
  const reportError = (error) => console.warn('WebMCP tool registration failed', error);
  toolsRegistered = true;
  try {
    Promise.resolve(registry.registerTool({
      name: 'inspect_cake',
      description: '查看蛋糕桌当前是第几盘、还剩哪些口味，不会吃掉蛋糕。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      async execute() {
        await loadState({ quiet: true });
        return {
          round: state.round,
          limits: { messageMaxLength: Number(config.limits?.messageMaxLength) || 500 },
          availableSlices: slices.filter((slice) => !state.eaten.includes(slice.id)).map(({ id, name }) => ({ id, name })),
          plate: state.plate,
        };
      },
    })).catch(reportError);
    Promise.resolve(registry.registerTool({
      name: 'eat_cake_slice',
      description: '从蛋糕桌上选择并吃掉一块，得到一张私有小纸条；可同时留下公开留言。',
      inputSchema: {
        type: 'object',
        properties: {
          sliceId: { type: 'string', enum: slices.map((slice) => slice.id), description: '先调用 inspect_cake 查看剩余选项。' },
          eaterName: { type: 'string', maxLength: 24, description: '公开署名；留空则由服务端生成编号。' },
          message: { type: 'string', maxLength: Number(config.limits?.messageMaxLength) || 500, description: `可选的公开留言，最多 ${Number(config.limits?.messageMaxLength) || 500} 个字符。` },
        },
        required: ['sliceId'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      async execute(input) {
        if (!input || typeof input !== 'object' || typeof input.sliceId !== 'string') throw new Error('请提供有效的 sliceId。');
        if (!stateReady) await loadState({ quiet: true });
        const eaterName = typeof input.eaterName === 'string' ? input.eaterName : '';
        guestName = eaterName.trim();
        guestNamed = true;
        try { localStorage.setItem('cake-guest-name-v1', guestName); } catch {}
        nameStage.hidden = true;
        return eatSlice(input.sliceId, { eaterName, message: typeof input.message === 'string' ? input.message : '' });
      },
    })).catch(reportError);
    Promise.resolve(registry.registerTool({
      name: 'read_past_plates',
      description: '翻阅历史来客簿。上一页前往较新记录，下一页前往较旧记录，也可以直接回到最新。不会返回任何人的私有纸条。',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['previous', 'next', 'latest'], description: '上一页、下一页或回到最新。' },
          round: { type: 'integer', minimum: 1, description: 'previous 和 next 需要当前正在看的盘号；latest 不需要。' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      async execute(input) {
        if (!input || !['previous', 'next', 'latest'].includes(input.action)) throw new Error('请选择 previous、next 或 latest。');
        if (input.action !== 'latest' && !Number.isInteger(input.round)) throw new Error('上一页或下一页需要提供当前 round。');
        const query = new URLSearchParams({ action: input.action });
        if (Number.isInteger(input.round)) query.set('round', String(input.round));
        const target = `/api/agent/history?${query}`;
        const { response, payload } = await fetchJson(target);
        if (!response.ok) throw new Error('这一盘暂时翻不到。');
        return payload;
      },
    })).catch(reportError);
  } catch (error) {
    toolsRegistered = false;
    reportError(error);
  }
}

document.documentElement.dataset.cakeReady = '1';
if (!guestNamed) requestAnimationFrame(() => guestNameInput.focus());
void loadState().catch(showError);
