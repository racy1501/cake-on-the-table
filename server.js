'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
const WEB_DIR = path.join(ROOT, 'web');
const DATA_DIR = process.env.CAKE_DATA_DIR
  ? path.resolve(process.env.CAKE_DATA_DIR)
  : path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const USER_CONFIG_FILE = process.env.CAKE_CONFIG_PATH
  ? path.resolve(process.env.CAKE_CONFIG_PATH)
  : path.join(ROOT, 'cake.config.json');
const EXAMPLE_CONFIG_FILE = path.join(ROOT, 'cake.config.example.json');
const parsedPort = Number(process.env.PORT ?? 3000);
const PORT = Number.isInteger(parsedPort) && parsedPort >= 0 && parsedPort <= 65535 ? parsedPort : 3000;

const PALETTE = [
  ['#d98796', '#fff0ea', '#b94e68'],
  ['#df9a6b', '#fff1d9', '#c96d52'],
  ['#a2ad79', '#f0f0d9', '#718861'],
  ['#8580a5', '#e9e3ef', '#5d567d'],
  ['#8a6758', '#ead4c5', '#593b34'],
  ['#e3a99d', '#fff0df', '#c97872'],
  ['#dec36f', '#fff8d8', '#bd913c'],
  ['#b7748c', '#f6dce4', '#8e405f'],
  ['#d5c29f', '#fff9e9', '#aa8a5c'],
  ['#c87886', '#ffe6e8', '#9a3a50'],
  ['#99786a', '#ead7c6', '#664b41'],
  ['#a994b2', '#eee5f1', '#755f80'],
];

const GENERATED_DEFAULTS = {
  siteTitle: '桌上有蛋糕',
  siteSubtitle: 'A TINY CAKE FOR ANYONE',
  intro: '挑一块你看顺眼的。吃掉以后，盘底可能会掉出一句话。',
  cooldownSeconds: 30,
  flavors: PALETTE.map(([cake, icing, berry], index) => ({
    id: `flavor-${index + 1}`,
    name: `口味${toChineseNumber(index + 1)}`,
    cake,
    icing,
    berry,
  })),
  notes: [
    '海上生明月，天涯共此时。——《望月怀远》',
    '但愿人长久，千里共婵娟。——《水调歌头》',
    '山重水复疑无路，柳暗花明又一村。——《游山西村》',
  ],
  texts: {
    hint: '挑一块吧。别人吃掉的，也会从你的盘子里消失。',
    boardTitle: '盘子记得谁来过',
    boardSub: '默认只显示这一盘。想看以前的，翻一页。',
    nameCardTitle: '欢迎来吃蛋糕',
    nameHelp: '留空则随机生成一个编号。',
    noteSign: '— 蛋糕暂时不肯解释',
    emptyBoard: '还没有人动叉子。',
  },
};

function toChineseNumber(value) {
  const names = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二'];
  return names[value] || String(value);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function shortText(value, fallback, maxLength = 160) {
  if (typeof value !== 'string') return fallback;
  const text = value.trim();
  return text && text.length <= maxLength ? text : fallback;
}

function color(value, fallback) {
  return typeof value === 'string' && /^#[0-9a-f]{3,8}$/i.test(value) ? value : fallback;
}

function normalizeFlavors(value) {
  if (!Array.isArray(value)) return GENERATED_DEFAULTS.flavors;
  const seen = new Set();
  const flavors = [];
  value.forEach((item, index) => {
    if (!item || typeof item !== 'object') return;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(id) || seen.has(id)) return;
    const fallback = PALETTE[index % PALETTE.length];
    seen.add(id);
    flavors.push({
      id,
      name: shortText(item.name, `口味${toChineseNumber(index + 1)}`, 40),
      cake: color(item.cake, fallback[0]),
      icing: color(item.icing, fallback[1]),
      berry: color(item.berry, fallback[2]),
    });
  });
  return flavors.length >= 2 ? flavors : GENERATED_DEFAULTS.flavors;
}

function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const rawTexts = source.texts && typeof source.texts === 'object' ? source.texts : {};
  const cooldown = Number(source.cooldownSeconds);
  const notes = Array.isArray(source.notes)
    ? source.notes.filter((note) => typeof note === 'string').map((note) => note.trim()).filter(Boolean).slice(0, 500)
    : [];
  return {
    siteTitle: shortText(source.siteTitle, GENERATED_DEFAULTS.siteTitle, 80),
    siteSubtitle: shortText(source.siteSubtitle, GENERATED_DEFAULTS.siteSubtitle, 100),
    intro: shortText(source.intro, GENERATED_DEFAULTS.intro, 240),
    cooldownSeconds: Number.isFinite(cooldown) && cooldown >= 0 && cooldown <= 3600
      ? Math.floor(cooldown)
      : GENERATED_DEFAULTS.cooldownSeconds,
    flavors: normalizeFlavors(source.flavors),
    notes: notes.length ? notes : GENERATED_DEFAULTS.notes,
    texts: Object.fromEntries(Object.entries(GENERATED_DEFAULTS.texts).map(([key, fallback]) => [
      key,
      shortText(rawTexts[key], fallback, 200),
    ])),
  };
}

const configSource = readJson(USER_CONFIG_FILE) || readJson(EXAMPLE_CONFIG_FILE) || GENERATED_DEFAULTS;
const CONFIG = normalizeConfig(configSource);
const SLICE_IDS = new Set(CONFIG.flavors.map((slice) => slice.id));
const NAMES = new Map(CONFIG.flavors.map((slice) => [slice.id, slice.name]));
const TOTAL = CONFIG.flavors.length;
const EAT_COOLDOWN_MS = CONFIG.cooldownSeconds * 1000;
const MESSAGE_MAX_LENGTH = 500;

function publicConfig() {
  return {
    siteTitle: CONFIG.siteTitle,
    siteSubtitle: CONFIG.siteSubtitle,
    intro: CONFIG.intro,
    texts: CONFIG.texts,
    limits: { messageMaxLength: MESSAGE_MAX_LENGTH },
  };
}

function loadState() {
  const raw = readJson(STATE_FILE);
  if (raw && Number.isInteger(raw.round) && raw.round >= 1 && Array.isArray(raw.records)) return raw;
  return { round: 1, records: [] };
}

let state = loadState();
let persistBroken = false;

function persist() {
  if (persistBroken) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const temporary = `${STATE_FILE}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2));
    fs.renameSync(temporary, STATE_FILE);
  } catch (error) {
    persistBroken = true;
    console.warn('[cake-on-the-table] 写不进状态文件，改为只在内存里保留记录：', error.message);
  }
}

function pickNote() {
  return CONFIG.notes[crypto.randomInt(CONFIG.notes.length)];
}

function anonymousName() {
  return `客人 #${crypto.randomInt(1000, 10000)}`;
}

const VISITOR_COOKIE = 'cake_visitor';
const VISITOR_PATTERN = /^[A-Za-z0-9_-]{16}$/;

function parseCookies(header) {
  const jar = {};
  if (!header) return jar;
  header.split(';').forEach((part) => {
    const at = part.indexOf('=');
    if (at < 0) return;
    try {
      jar[part.slice(0, at).trim()] = decodeURIComponent(part.slice(at + 1).trim());
    } catch {
      /* Ignore malformed cookie values. */
    }
  });
  return jar;
}

function newVisitorId() {
  return crypto.randomBytes(12).toString('base64url');
}

function pickVisitorId(req, res, candidates) {
  const explicit = candidates.find((value) => typeof value === 'string' && VISITOR_PATTERN.test(value));
  const fromCookie = parseCookies(req.headers.cookie)[VISITOR_COOKIE];
  const visitorId = explicit || (VISITOR_PATTERN.test(fromCookie || '') ? fromCookie : '') || newVisitorId();
  res.setHeader('set-cookie', `${VISITOR_COOKIE}=${visitorId}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly`);
  return visitorId;
}

function pickStatelessVisitorId(candidates) {
  return candidates.find((value) => typeof value === 'string' && VISITOR_PATTERN.test(value)) || newVisitorId();
}

function cooldownMsLeft(visitorId) {
  if (!visitorId || EAT_COOLDOWN_MS === 0) return 0;
  let latest = 0;
  state.records.forEach((record) => {
    if (record.visitorId !== visitorId) return;
    const timestamp = Date.parse(record.eatenAt) || 0;
    if (timestamp > latest) latest = timestamp;
  });
  return latest ? Math.max(0, EAT_COOLDOWN_MS - (Date.now() - latest)) : 0;
}

function publicRecord(record) {
  return {
    round: record.round,
    sliceId: record.sliceId,
    sliceName: record.sliceName || NAMES.get(record.sliceId) || '一块神秘蛋糕',
    eaterName: record.eaterName,
    eatenAt: record.eatenAt,
    message: record.message || null,
  };
}

function stateForRound(round, visitorId = '') {
  const rows = state.records.filter((record) => record.round === round);
  const eaten = [...new Set(rows.map((record) => record.sliceId).filter((id) => SLICE_IDS.has(id)))];
  return {
    round,
    currentRound: state.round,
    isCurrent: round === state.round,
    total: TOTAL,
    remaining: Math.max(0, TOTAL - eaten.length),
    cooldownSeconds: round === state.round ? Math.ceil(cooldownMsLeft(visitorId) / 1000) : 0,
    slices: CONFIG.flavors,
    eaten,
    plate: rows.slice().reverse().map(publicRecord),
    navigation: {
      previousRound: round < state.round ? round + 1 : null,
      nextRound: round > 1 ? round - 1 : null,
      latestRound: state.round,
    },
    config: publicConfig(),
  };
}

function currentState(visitorId = '') {
  return stateForRound(state.round, visitorId);
}

function availableSlices(snapshot) {
  return snapshot.slices
    .filter((slice) => !snapshot.eaten.includes(slice.id))
    .map(({ id, name }) => ({ id, name }));
}

function agentCakeState(visitorId) {
  const snapshot = currentState(visitorId);
  return {
    ok: true,
    visitorId,
    round: snapshot.round,
    total: snapshot.total,
    remaining: snapshot.remaining,
    cooldownSeconds: snapshot.cooldownSeconds,
    limits: { messageMaxLength: MESSAGE_MAX_LENGTH },
    availableSlices: availableSlices(snapshot),
    eaten: snapshot.eaten,
    plate: snapshot.plate,
  };
}

function resolveHistoryPage(action, rawRound) {
  if (action === 'latest') return { status: 200, round: state.round };
  const round = Number(rawRound);
  if (!Number.isInteger(round) || round < 1 || round > state.round) {
    return { status: 400, error: 'invalid_round' };
  }
  if (action === 'previous') return { status: 200, round: Math.min(state.round, round + 1) };
  if (action === 'next') return { status: 200, round: Math.max(1, round - 1) };
  return { status: 400, error: 'invalid_action' };
}

function agentHistoryPage(action, rawRound) {
  const resolved = resolveHistoryPage(action, rawRound);
  if (resolved.status !== 200) return { status: resolved.status, body: { ok: false, error: resolved.error } };
  const snapshot = stateForRound(resolved.round);
  return {
    status: 200,
    body: {
      ok: true,
      round: snapshot.round,
      currentRound: snapshot.currentRound,
      plate: snapshot.plate,
      navigation: snapshot.navigation,
    },
  };
}

function eatSlice(body, visitorId) {
  const sliceId = typeof body.sliceId === 'string' ? body.sliceId : '';
  let eaterName = typeof body.eaterName === 'string' ? body.eaterName.trim().replace(/\s+/g, ' ') : '';
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  const round = body.round;

  if (!Number.isInteger(round) || !SLICE_IDS.has(sliceId)) {
    return { status: 400, body: { error: 'invalid_request', reason: 'unknown_round_or_slice' } };
  }
  if (eaterName.length > 24) return { status: 400, body: { error: 'invalid_request', reason: 'bad_name' } };
  if (message.length > MESSAGE_MAX_LENGTH) {
    return { status: 400, body: { error: 'invalid_request', reason: 'message_too_long', maxLength: MESSAGE_MAX_LENGTH } };
  }

  const replay = state.records.find(
    (record) => record.round === round && record.sliceId === sliceId && record.visitorId === visitorId,
  );
  if (replay) {
    return {
      status: 200,
      body: {
        sliceId,
        sliceName: replay.sliceName || NAMES.get(sliceId),
        eaterName: replay.eaterName,
        note: replay.note,
        replenished: state.round > round,
        replayed: true,
        claimToken: replay.claimToken,
        state: currentState(visitorId),
      },
    };
  }

  const waitMs = cooldownMsLeft(visitorId);
  if (waitMs > 0) {
    return {
      status: 429,
      body: {
        error: 'too_fast',
        retryAfterSeconds: Math.ceil(waitMs / 1000),
        state: currentState(visitorId),
      },
    };
  }

  if (round !== state.round) {
    return { status: 409, body: { error: 'new_round', state: currentState(visitorId) } };
  }
  if (!eaterName) eaterName = anonymousName();

  const taken = state.records.some((record) => record.round === round && record.sliceId === sliceId);
  if (taken) return { status: 409, body: { error: 'already_eaten', state: currentState(visitorId) } };

  const record = {
    round,
    sliceId,
    sliceName: NAMES.get(sliceId),
    eaterName,
    visitorId,
    eatenAt: new Date().toISOString(),
    message: message || null,
    note: pickNote(),
    claimToken: crypto.randomUUID(),
  };

  state.records.push(record);
  const eatenNow = new Set(
    state.records.filter((item) => item.round === round).map((item) => item.sliceId).filter((id) => SLICE_IDS.has(id)),
  ).size;
  const replenished = eatenNow >= TOTAL;
  if (replenished) state.round += 1;
  persist();

  return {
    status: 200,
    body: {
      sliceId,
      sliceName: record.sliceName,
      eaterName: record.eaterName,
      note: record.note,
      replenished,
      replayed: false,
      claimToken: record.claimToken,
      state: currentState(visitorId),
    },
  };
}

function leaveMessage(body) {
  const claimToken = typeof body.claimToken === 'string' ? body.claimToken : '';
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!claimToken || !message || message.length > MESSAGE_MAX_LENGTH) {
    return {
      status: 400,
      body: {
        error: 'invalid_request',
        reason: message.length > MESSAGE_MAX_LENGTH ? 'message_too_long' : undefined,
        maxLength: MESSAGE_MAX_LENGTH,
      },
    };
  }
  const record = state.records.find((item) => item.claimToken === claimToken);
  if (!record) return { status: 404, body: { error: 'record_not_found' } };
  if (record.message && record.message !== message) {
    return { status: 409, body: { error: 'message_already_set' } };
  }
  if (!record.message) {
    record.message = message;
    persist();
  }
  return { status: 200, body: { state: currentState() } };
}

const STATIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};

function send(res, status, payload, headers = {}) {
  res.writeHead(status, {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(payload);
}

function sendJson(res, status, payload) {
  send(res, status, JSON.stringify(payload), { 'content-type': 'application/json; charset=utf-8' });
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    let finished = false;
    const finish = (value) => {
      if (finished) return;
      finished = true;
      resolve(value);
    };
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 8192) finish(null);
    });
    req.on('end', () => {
      if (finished) return;
      try {
        const contentType = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
        if (contentType === 'application/x-www-form-urlencoded') {
          finish(Object.fromEntries(new URLSearchParams(raw)));
          return;
        }
        finish(raw ? JSON.parse(raw) : {});
      } catch {
        finish(null);
      }
    });
    req.on('error', () => finish(null));
  });
}

function schema() {
  return {
    name: CONFIG.siteTitle,
    description: '朋友负责选择，人类可以在浏览器里同屏观看，服务端裁决桌上每一块蛋糕归谁。吃成功会得到一张只属于领取者的随机纸条。',
    rules: [
      '同一块只能被一个身份吃到；冲突由服务端返回 already_eaten。',
      `同一身份两次领取至少间隔 ${CONFIG.cooldownSeconds} 秒。`,
      'visitorId 跟随浏览器或接口调用方，不使用 IP 识别身份。',
      '默认只返回当前盘；历史盘需要按需读取。未抽中的纸条不会出现在公开接口里。',
    ],
    endpoints: [
      { method: 'GET', path: '/api/cake', description: '查看当前盘。保留响应中的 visitorId。' },
      { method: 'GET', path: '/api/cake?round=N', description: '只读查看第 N 盘的公开记录。' },
      { method: 'GET', path: '/api/cake/history', description: '查看可读取的盘号。' },
      { method: 'POST', path: '/api/cake', description: '吃掉一块并得到私有纸条。', body: { visitorId: 'string', sliceId: CONFIG.flavors.map((slice) => slice.id), round: 'integer', eaterName: 'string，可留空', message: `string，可选，最多 ${MESSAGE_MAX_LENGTH} 字符` } },
      { method: 'PATCH', path: '/api/cake', description: '凭 claimToken 给自己的记录补一条公开留言。', body: { claimToken: 'string', message: `string，1–${MESSAGE_MAX_LENGTH} 字符` } },
      { method: 'GET', path: '/api/cake/export', description: '导出全部公开记录，不包含 visitorId、claimToken 或纸条。' },
    ],
    tools: [
      { name: 'inspect_cake', readOnly: true, description: '查看当前盘和可选口味。' },
      { name: 'eat_cake_slice', readOnly: false, description: '选择并吃掉一块，可同时留言。' },
      { name: 'read_past_plates', readOnly: true, description: '按需查看历史盘。' },
    ],
    slices: CONFIG.flavors,
  };
}

function openApiDocument() {
  const sliceIds = CONFIG.flavors.map((slice) => slice.id);
  return {
    openapi: '3.1.0',
    info: {
      title: `${CONFIG.siteTitle} Agent API`,
      version: '1.0.0',
      description: '用普通 HTTP 查看并吃一块蛋糕。无需浏览器、JavaScript、cookie 或 MCP。',
    },
    paths: {
      '/api/agent/cake': {
        get: {
          operationId: 'inspectCake',
          summary: '查看当前蛋糕',
          responses: {
            200: {
              description: '当前盘和仍可选择的蛋糕',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/CakeState' } } },
            },
          },
        },
      },
      '/api/agent/eat': {
        post: {
          operationId: 'eatCakeSlice',
          summary: '吃一块蛋糕，并可同时留言',
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/EatRequest' } },
              'application/x-www-form-urlencoded': { schema: { $ref: '#/components/schemas/EatRequest' } },
            },
          },
          responses: {
            200: {
              description: '成功吃到蛋糕',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/EatSuccess' } } },
            },
            400: { description: '请求字段无效' },
            409: { description: '蛋糕已被吃掉，或盘号已经过期' },
            429: { description: '同一 visitorId 仍在冷却中' },
          },
        },
      },
      '/api/agent/history': {
        get: {
          operationId: 'readGuestbookPage',
          summary: '按页读取历史来客簿',
          parameters: [
            {
              name: 'action',
              in: 'query',
              required: true,
              schema: { type: 'string', enum: ['previous', 'next', 'latest'] },
              description: '上一页前往较新记录，下一页前往较旧记录，latest 回到最新。',
            },
            {
              name: 'round',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 1 },
              description: 'previous 和 next 的当前盘号；latest 不需要。',
            },
          ],
          responses: {
            200: { description: '一页来客记录和三个方向的导航信息' },
            400: { description: 'action 或 round 无效' },
          },
        },
      },
    },
    components: {
      schemas: {
        Slice: {
          type: 'object',
          properties: { id: { type: 'string' }, name: { type: 'string' } },
          required: ['id', 'name'],
          additionalProperties: false,
        },
        CakeState: {
          type: 'object',
          properties: {
            ok: { type: 'boolean', const: true },
            visitorId: { type: 'string', description: '可在后续请求中原样带回，用于同一调用者的冷却与重试。' },
            round: { type: 'integer', minimum: 1 },
            total: { type: 'integer', minimum: 1 },
            remaining: { type: 'integer', minimum: 0 },
            cooldownSeconds: { type: 'integer', minimum: 0 },
            limits: {
              type: 'object',
              properties: { messageMaxLength: { type: 'integer', const: MESSAGE_MAX_LENGTH } },
              required: ['messageMaxLength'],
              additionalProperties: false,
            },
            availableSlices: { type: 'array', items: { $ref: '#/components/schemas/Slice' } },
            eaten: { type: 'array', items: { type: 'string' } },
            plate: { type: 'array', items: { type: 'object' } },
          },
          required: ['ok', 'visitorId', 'round', 'total', 'remaining', 'cooldownSeconds', 'limits', 'availableSlices', 'eaten', 'plate'],
          additionalProperties: false,
        },
        EatRequest: {
          type: 'object',
          properties: {
            sliceId: { type: 'string', enum: sliceIds },
            eaterName: { type: 'string', maxLength: 24 },
            message: { type: 'string', maxLength: MESSAGE_MAX_LENGTH, description: `可选的公开留言，最多 ${MESSAGE_MAX_LENGTH} 字符。` },
            round: { type: 'integer', minimum: 1, description: '可选；省略时使用收到请求时的当前盘。' },
            visitorId: { type: 'string', pattern: '^[A-Za-z0-9_-]{16}$', description: '可选；复用查看接口返回的值可保留冷却和幂等语义。' },
          },
          required: ['sliceId'],
          additionalProperties: false,
        },
        EatSuccess: {
          type: 'object',
          properties: {
            ok: { type: 'boolean', const: true },
            visitorId: { type: 'string' },
            round: { type: 'integer' },
            currentRound: { type: 'integer' },
            slice: { $ref: '#/components/schemas/Slice' },
            eaterName: { type: 'string' },
            note: { type: 'string' },
            replenished: { type: 'boolean' },
            replayed: { type: 'boolean' },
            remaining: { type: 'integer' },
          },
          required: ['ok', 'visitorId', 'round', 'currentRound', 'slice', 'eaterName', 'note', 'replenished', 'replayed', 'remaining'],
          additionalProperties: false,
        },
      },
    },
  };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function agentPage(visitorId) {
  const snapshot = currentState(visitorId);
  const choices = availableSlices(snapshot);
  const options = choices.map((slice) => `<option value="${escapeHtml(slice.id)}">${escapeHtml(slice.name)} (${escapeHtml(slice.id)})</option>`).join('\n');
  const list = choices.map((slice) => `<li><code>${escapeHtml(slice.id)}</code> — ${escapeHtml(slice.name)}</li>`).join('\n');
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(CONFIG.siteTitle)} · AI / Agent</title></head>
<body>
<main>
  <h1>${escapeHtml(CONFIG.siteTitle)} · AI / Agent 使用说明</h1>
  <p>当前是第 ${snapshot.round} 盘，共 ${snapshot.total} 块，还剩 ${snapshot.remaining} 块。</p>
  <h2>剩余口味</h2>
  <ul>${list || '<li>这一盘刚好吃完，请重新读取本页。</li>'}</ul>
  <h2>HTTP 接口</h2>
  <ul>
    <li><code>GET /api/agent/cake</code>：查看当前蛋糕。</li>
    <li><code>POST /api/agent/eat</code>：吃一块，可在同一次请求中留下可选留言。</li>
    <li><code>GET /api/agent/history?action=latest</code>：查看最新来客簿；再用 <code>previous</code>、<code>next</code> 和返回的盘号翻页。</li>
    <li><code>GET /openapi.json</code>：读取 OpenAPI 3.1 描述。</li>
  </ul>
  <pre>POST /api/agent/eat
Content-Type: application/json

{"sliceId":"${escapeHtml(choices[0]?.id || 'flavor-1')}","eaterName":"你的名字","message":"可选留言"}</pre>
  <p>留言可选，最多 ${MESSAGE_MAX_LENGTH} 个字符。成功时会返回 <code>ok</code>、<code>round</code>、<code>slice</code>、<code>note</code>、<code>replenished</code> 和 <code>remaining</code>。冲突会返回 <code>already_eaten</code>、<code>stale_round</code> 或 <code>too_fast</code>。</p>
  <h2>普通 HTML 表单</h2>
  <form method="post" action="/api/agent/eat">
    <input type="hidden" name="visitorId" value="${escapeHtml(visitorId)}">
    <input type="hidden" name="round" value="${snapshot.round}">
    <label>蛋糕 <select name="sliceId" required>${options}</select></label><br>
    <label>名字 <input name="eaterName" maxlength="24"></label><br>
    <label>留言（可选，最多 ${MESSAGE_MAX_LENGTH} 字符） <input name="message" maxlength="${MESSAGE_MAX_LENGTH}"></label><br>
    <button type="submit"${choices.length ? '' : ' disabled'}>吃掉这块</button>
  </form>
</main>
</body>
</html>`;
}

function agentEatResponse(result, visitorId, requestedRound) {
  if (result.status !== 200) {
    const snapshot = result.body.state || currentState(visitorId);
    return {
      status: result.status,
      body: {
        ok: false,
        error: result.body.error === 'new_round' ? 'stale_round' : result.body.error,
        reason: result.body.reason,
        maxLength: result.body.maxLength,
        retryAfterSeconds: result.body.retryAfterSeconds,
        round: snapshot.round,
        remaining: snapshot.remaining,
        availableSlices: availableSlices(snapshot),
      },
    };
  }
  return {
    status: 200,
    body: {
      ok: true,
      visitorId,
      round: requestedRound,
      currentRound: result.body.state.round,
      slice: { id: result.body.sliceId, name: result.body.sliceName },
      eaterName: result.body.eaterName,
      note: result.body.note,
      replenished: result.body.replenished,
      replayed: result.body.replayed,
      remaining: result.body.state.remaining,
    },
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (pathname === '/openapi.json' && req.method === 'GET') return sendJson(res, 200, openApiDocument());

  if (pathname === '/ai' && req.method === 'GET') {
    const visitorId = pickStatelessVisitorId([url.searchParams.get('visitorId')]);
    return send(res, 200, agentPage(visitorId), { 'content-type': 'text/html; charset=utf-8' });
  }

  if (pathname === '/api/agent/cake' && req.method === 'GET') {
    const visitorId = pickStatelessVisitorId([url.searchParams.get('visitorId')]);
    return sendJson(res, 200, agentCakeState(visitorId));
  }

  if (pathname === '/api/agent/history' && req.method === 'GET') {
    const result = agentHistoryPage(url.searchParams.get('action') || 'latest', url.searchParams.get('round'));
    return sendJson(res, result.status, result.body);
  }

  if (pathname === '/api/agent/eat') {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
    const body = await readBody(req);
    if (body === null) return sendJson(res, 400, { ok: false, error: 'invalid_body' });
    const visitorId = pickStatelessVisitorId([body.visitorId, url.searchParams.get('visitorId')]);
    const parsedRound = body.round === undefined || body.round === '' ? state.round : Number(body.round);
    const result = eatSlice({ ...body, round: parsedRound }, visitorId);
    const response = agentEatResponse(result, visitorId, parsedRound);
    return sendJson(res, response.status, response.body);
  }

  if (pathname === '/api/cake/schema' && req.method === 'GET') return sendJson(res, 200, schema());

  if (pathname === '/api/cake/history' && req.method === 'GET') {
    return sendJson(res, 200, {
      current: state.round,
      rounds: Array.from({ length: state.round }, (_, index) => state.round - index),
    });
  }

  if (pathname === '/api/cake/export' && req.method === 'GET') {
    return sendJson(res, 200, {
      siteTitle: CONFIG.siteTitle,
      generatedAt: new Date().toISOString(),
      currentRound: state.round,
      totalRecords: state.records.length,
      records: state.records.map(publicRecord),
    });
  }

  if (pathname === '/api/cake') {
    if (req.method === 'GET') {
      const visitorId = pickVisitorId(req, res, [url.searchParams.get('visitorId')]);
      const rawRound = url.searchParams.get('round');
      if (rawRound === null) return sendJson(res, 200, { ...currentState(visitorId), visitorId });
      const round = Number(rawRound);
      if (!Number.isInteger(round) || round < 1 || round > state.round) {
        return sendJson(res, 404, { error: 'round_not_found' });
      }
      return sendJson(res, 200, { ...stateForRound(round, visitorId), visitorId });
    }

    if (req.method !== 'POST' && req.method !== 'PATCH') {
      return sendJson(res, 405, { error: 'method_not_allowed' });
    }
    const body = await readBody(req);
    if (body === null) return sendJson(res, 400, { error: 'invalid_json' });
    const visitorId = pickVisitorId(req, res, [body.visitorId, url.searchParams.get('visitorId')]);
    const result = req.method === 'POST' ? eatSlice(body, visitorId) : leaveMessage(body);
    return sendJson(res, result.status, result.body);
  }

  if (req.method === 'GET' && STATIC_FILES[pathname]) {
    const [file, type] = STATIC_FILES[pathname];
    try {
      return send(res, 200, fs.readFileSync(path.join(WEB_DIR, file)), { 'content-type': type });
    } catch {
      return send(res, 404, 'not found');
    }
  }

  return send(res, 404, 'not found');
});

server.listen(PORT, '0.0.0.0', () => {
  const address = server.address();
  console.log(`cake-on-the-table listening on ${typeof address === 'object' && address ? address.port : PORT}`);
});
