import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_NOTES = [
  '海上生明月，天涯共此时。——《望月怀远》',
  '但愿人长久，千里共婵娟。——《水调歌头》',
  '山重水复疑无路，柳暗花明又一村。——《游山西村》',
];
let visitorCounter = 0;
const freshVisitor = () => `T${String(++visitorCounter).padStart(15, '0')}`;

function pass(label) {
  console.log(`PASS  ${label}`);
}

async function startServer({ configPath } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'cake-on-the-table-test-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: '0',
      CAKE_DATA_DIR: dataDir,
      ...(configPath ? { CAKE_CONFIG_PATH: configPath } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server start timeout\n${logs}`)), 5000);
    const inspect = (chunk) => {
      logs += chunk.toString();
      const match = logs.match(/cake-on-the-table listening on (\d+)/);
      if (!match) return;
      clearTimeout(timer);
      resolve(Number(match[1]));
    };
    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early (${code})\n${logs}`));
    });
  });
  return {
    base: `http://127.0.0.1:${port}`,
    async stop() {
      if (child.exitCode === null) child.kill();
      await new Promise((resolve) => child.exitCode === null ? child.once('exit', resolve) : resolve());
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

async function json(base, method, route, body) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

async function verifyMainServer() {
  const missingConfig = path.join(tmpdir(), `cake-on-the-table-missing-${Date.now()}.json`);
  const app = await startServer({ configPath: missingConfig });
  try {
    const first = await json(app.base, 'GET', '/api/cake');
    assert.equal(first.response.status, 200);
    assert.equal(first.response.headers.get('cache-control'), 'no-store');
    assert.equal(first.body.total, 12);
    assert.equal(first.body.plate.length, 0);
    assert.equal(first.body.slices[0].name, '口味一');
    assert.match(first.body.visitorId, /^[A-Za-z0-9_-]{16}$/);
    pass('配置文件缺失时使用安全默认值并正常启动');

    const second = await json(app.base, 'GET', '/api/cake');
    assert.equal(second.body.round, first.body.round);
    assert.equal(second.body.eaten.length, first.body.eaten.length);
    pass('两位访客看到同一盘');

    const round = first.body.round;
    const target = first.body.slices[0].id;
    const racers = [freshVisitor(), freshVisitor(), freshVisitor()];
    const race = await Promise.all(racers.map((visitorId, index) => json(app.base, 'POST', '/api/cake', {
      visitorId,
      sliceId: target,
      round,
      eaterName: ['甲', '乙', '丙'][index],
    })));
    const winnerIndex = race.findIndex((result) => result.response.status === 200);
    assert.notEqual(winnerIndex, -1);
    assert.equal(race.filter((result) => result.response.status === 200).length, 1);
    assert.equal(race.filter((result) => result.response.status === 409 && result.body.error === 'already_eaten').length, 2);
    pass('三人同抢一块时只有一人成功');

    const winner = race[winnerIndex];
    const winnerVisitor = racers[winnerIndex];
    const replay = await json(app.base, 'POST', '/api/cake', {
      visitorId: winnerVisitor,
      sliceId: target,
      round,
      eaterName: '换名字也不重抽',
    });
    assert.equal(replay.response.status, 200);
    assert.equal(replay.body.replayed, true);
    assert.equal(replay.body.note, winner.body.note);
    assert.equal(replay.body.claimToken, winner.body.claimToken);
    pass('同一身份重试同一块会拿回原纸条与原凭证');

    const currentAfterRace = await json(app.base, 'GET', '/api/cake');
    const anotherSlice = currentAfterRace.body.slices.find((slice) => !currentAfterRace.body.eaten.includes(slice.id));
    const tooFast = await json(app.base, 'POST', '/api/cake', {
      visitorId: winnerVisitor,
      sliceId: anotherSlice.id,
      round,
      eaterName: '甲',
    });
    assert.equal(tooFast.response.status, 429);
    assert.equal(tooFast.body.error, 'too_fast');
    assert.ok(tooFast.body.retryAfterSeconds > 0);
    const otherVisitor = await json(app.base, 'POST', '/api/cake', {
      visitorId: freshVisitor(),
      sliceId: anotherSlice.id,
      round,
      eaterName: '另一位',
    });
    assert.equal(otherVisitor.response.status, 200);
    pass('冷却只限制同一身份，不影响别人');

    const agentView = await json(app.base, 'GET', '/api/agent/cake');
    assert.equal(agentView.response.status, 200);
    assert.equal(agentView.response.headers.get('set-cookie'), null);
    assert.equal(agentView.body.ok, true);
    assert.equal(agentView.body.limits.messageMaxLength, 500);
    assert.match(agentView.body.visitorId, /^[A-Za-z0-9_-]{16}$/);
    assert.ok(agentView.body.availableSlices.length > 0);
    const agentSlice = agentView.body.availableSlices[0];
    const agentEat = await json(app.base, 'POST', '/api/agent/eat', {
      sliceId: agentSlice.id,
      eaterName: '无 Cookie 的 Agent',
      message: '我用普通 HTTP 吃到了。',
    });
    assert.equal(agentEat.response.status, 200);
    assert.equal(agentEat.response.headers.get('set-cookie'), null);
    assert.equal(agentEat.body.ok, true);
    assert.equal(agentEat.body.slice.id, agentSlice.id);
    assert.equal(agentEat.body.round, round);
    assert.equal(typeof agentEat.body.note, 'string');
    const agentAfter = await json(app.base, 'GET', `/api/agent/cake?visitorId=${agentEat.body.visitorId}`);
    assert.equal(agentAfter.body.plate.find((record) => record.sliceId === agentSlice.id)?.message, '我用普通 HTTP 吃到了。');
    const agentNext = agentAfter.body.availableSlices[0];
    const agentTooFast = await json(app.base, 'POST', '/api/agent/eat', {
      visitorId: agentEat.body.visitorId,
      sliceId: agentNext.id,
      eaterName: '同一个 Agent',
    });
    assert.equal(agentTooFast.response.status, 429);
    assert.equal(agentTooFast.body.error, 'too_fast');
    pass('无 Cookie 的 Agent 可查看、吃蛋糕并同时留言，复用 visitorId 时保留冷却');

    const beforeAgentRace = await json(app.base, 'GET', '/api/agent/cake');
    const agentRaceSlice = beforeAgentRace.body.availableSlices[0];
    const agentRace = await Promise.all([freshVisitor(), freshVisitor()].map((agentId, index) => json(app.base, 'POST', '/api/agent/eat', {
      visitorId: agentId,
      sliceId: agentRaceSlice.id,
      eaterName: `HTTP Agent ${index + 1}`,
      round,
    })));
    assert.equal(agentRace.filter((result) => result.response.status === 200).length, 1);
    assert.equal(agentRace.filter((result) => result.response.status === 409 && result.body.error === 'already_eaten').length, 1);
    pass('两个普通 HTTP Agent 同抢一块时仍由正式逻辑裁决');

    const beforeForm = await json(app.base, 'GET', '/api/agent/cake');
    const formSlice = beforeForm.body.availableSlices[0];
    const formResponse = await fetch(`${app.base}/api/agent/eat`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ sliceId: formSlice.id, eaterName: '表单访客', message: '普通表单也可以。' }),
    });
    const formBody = await formResponse.json();
    assert.equal(formResponse.status, 200);
    assert.equal(formBody.ok, true);
    assert.equal(formBody.slice.id, formSlice.id);
    pass('不会执行复杂 JavaScript 的调用者可用普通 HTML 表单参与');

    const tooLongMessage = await json(app.base, 'PATCH', '/api/cake', { claimToken: winner.body.claimToken, message: '长'.repeat(501) });
    assert.equal(tooLongMessage.response.status, 400);
    assert.equal(tooLongMessage.body.reason, 'message_too_long');
    assert.equal(tooLongMessage.body.maxLength, 500);
    const wrongToken = await json(app.base, 'PATCH', '/api/cake', { claimToken: 'wrong-token', message: '不该写上' });
    assert.equal(wrongToken.response.status, 404);
    const maxLengthMessage = '长'.repeat(500);
    const rightToken = await json(app.base, 'PATCH', '/api/cake', { claimToken: winner.body.claimToken, message: maxLengthMessage });
    assert.equal(rightToken.response.status, 200);
    assert.equal(rightToken.body.state.plate.find((record) => record.sliceId === target)?.message, maxLengthMessage);
    const overwrite = await json(app.base, 'PATCH', '/api/cake', { claimToken: winner.body.claimToken, message: '试图覆盖' });
    assert.equal(overwrite.response.status, 409);
    pass('留言可写满 500 字符，超出会返回明确上限，且不能写别人或覆盖已有留言');

    const emptyNameState = await json(app.base, 'GET', '/api/cake');
    const emptyNameSlice = emptyNameState.body.slices.find((slice) => !emptyNameState.body.eaten.includes(slice.id));
    const anonymous = await json(app.base, 'POST', '/api/cake', {
      visitorId: freshVisitor(),
      sliceId: emptyNameSlice.id,
      round,
      eaterName: '   ',
    });
    assert.equal(anonymous.response.status, 200);
    assert.match(anonymous.body.eaterName, /^客人 #\d{4}$/);
    const longName = await json(app.base, 'POST', '/api/cake', {
      visitorId: freshVisitor(),
      sliceId: 'flavor-12',
      round,
      eaterName: 'x'.repeat(25),
    });
    assert.equal(longName.response.status, 400);
    const badSlice = await json(app.base, 'POST', '/api/cake', {
      visitorId: freshVisitor(),
      sliceId: 'not-a-flavor',
      round,
      eaterName: '访客',
    });
    assert.equal(badSlice.response.status, 400);
    pass('匿名名字、超长名字与不存在口味按约定处理');

    let finalClaim = null;
    while (true) {
      const snapshot = await json(app.base, 'GET', '/api/cake');
      if (snapshot.body.round !== round) break;
      const free = snapshot.body.slices.find((slice) => !snapshot.body.eaten.includes(slice.id));
      assert.ok(free);
      const visitorId = freshVisitor();
      const result = await json(app.base, 'POST', '/api/cake', {
        visitorId,
        sliceId: free.id,
        round,
        eaterName: `访客-${free.id}`,
      });
      assert.equal(result.response.status, 200);
      if (result.body.replenished) finalClaim = { visitorId, sliceId: free.id, note: result.body.note };
    }
    const next = await json(app.base, 'GET', '/api/cake');
    assert.equal(next.body.round, round + 1);
    assert.equal(next.body.remaining, 12);
    assert.equal(next.body.plate.length, 0);
    assert.ok(finalClaim);
    pass('最后一块触发下一盘，新盘完整且默认不混入历史');

    const finalReplay = await json(app.base, 'POST', '/api/cake', {
      visitorId: finalClaim.visitorId,
      sliceId: finalClaim.sliceId,
      round,
      eaterName: '最后一位',
    });
    assert.equal(finalReplay.response.status, 200);
    assert.equal(finalReplay.body.replayed, true);
    assert.equal(finalReplay.body.note, finalClaim.note);
    pass('末块换盘后重试仍返回原纸条');

    const oldPlate = await json(app.base, 'GET', `/api/cake?round=${round}`);
    assert.equal(oldPlate.response.status, 200);
    assert.equal(oldPlate.body.plate.length, 12);
    assert.equal(oldPlate.body.remaining, 0);
    const history = await json(app.base, 'GET', '/api/cake/history');
    assert.deepEqual(history.body.rounds, [round + 1, round]);
    assert.deepEqual(next.body.navigation, { previousRound: null, nextRound: round, latestRound: round + 1 });
    assert.deepEqual(oldPlate.body.navigation, { previousRound: round + 1, nextRound: null, latestRound: round + 1 });
    const latestGuestbook = await json(app.base, 'GET', '/api/agent/history?action=latest');
    assert.equal(latestGuestbook.response.status, 200);
    assert.equal(latestGuestbook.body.round, round + 1);
    const olderGuestbook = await json(app.base, 'GET', `/api/agent/history?action=next&round=${round + 1}`);
    assert.equal(olderGuestbook.response.status, 200);
    assert.equal(olderGuestbook.body.round, round);
    assert.equal(olderGuestbook.body.plate.length, 12);
    const newerGuestbook = await json(app.base, 'GET', `/api/agent/history?action=previous&round=${round}`);
    assert.equal(newerGuestbook.response.status, 200);
    assert.equal(newerGuestbook.body.round, round + 1);
    const latestAgain = await json(app.base, 'GET', '/api/agent/history?action=latest');
    assert.equal(latestAgain.body.round, round + 1);
    pass('人类与 Agent 共用上一页较新、下一页较旧、回到最新的翻页语义');
    const stale = await json(app.base, 'POST', '/api/cake', {
      visitorId: freshVisitor(),
      sliceId: 'flavor-1',
      round,
      eaterName: '迟到的人',
    });
    assert.equal(stale.response.status, 409);
    assert.equal(stale.body.error, 'new_round');
    const agentStale = await json(app.base, 'POST', '/api/agent/eat', {
      visitorId: freshVisitor(),
      sliceId: 'flavor-1',
      round,
      eaterName: '迟到的 Agent',
    });
    assert.equal(agentStale.response.status, 409);
    assert.equal(agentStale.body.error, 'stale_round');
    pass('历史按盘读取，旧盘号不能继续吃');

    const exportResult = await json(app.base, 'GET', '/api/cake/export');
    assert.equal(exportResult.body.totalRecords, 12);
    assert.equal(exportResult.body.records.length, 12);
    const publicPayloads = [next.body, oldPlate.body, history.body, exportResult.body];
    const schema = await json(app.base, 'GET', '/api/cake/schema');
    publicPayloads.push(schema.body);
    const serialized = JSON.stringify(publicPayloads);
    PUBLIC_NOTES.forEach((note) => assert.equal(serialized.includes(note), false));
    const publicRecords = JSON.stringify([...oldPlate.body.plate, ...exportResult.body.records]);
    assert.equal(publicRecords.includes('claimToken'), false);
    assert.equal(publicRecords.includes('visitorId'), false);
    assert.equal(publicRecords.includes('"note"'), false);
    assert.ok(schema.body.tools.some((tool) => tool.name === 'read_past_plates'));
    pass('导出完整公开记录，公开接口不泄漏纸条、身份或领取凭证');

    const aiPage = await (await fetch(`${app.base}/ai`)).text();
    assert.match(aiPage, /当前是第/);
    assert.match(aiPage, /action="\/api\/agent\/eat"/);
    assert.match(aiPage, /\/api\/agent\/history\?action=latest/);
    assert.match(aiPage, /\/openapi\.json/);
    const openApi = await json(app.base, 'GET', '/openapi.json');
    assert.equal(openApi.response.status, 200);
    assert.equal(openApi.body.openapi, '3.1.0');
    assert.equal(openApi.body.components.schemas.EatRequest.properties.message.maxLength, 500);
    assert.ok(openApi.body.paths['/api/agent/cake']);
    assert.ok(openApi.body.paths['/api/agent/eat']);
    assert.ok(openApi.body.paths['/api/agent/history']);
    JSON.parse(JSON.stringify(openApi.body));
    pass('/ai 可直接阅读并提交表单，OpenAPI 文档是合法 JSON');

    const html = await (await fetch(`${app.base}/`)).text();
    const client = await (await fetch(`${app.base}/app.js`)).text();
    assert.equal(/重新摆|重摆|reset/i.test(html + client), false);
    assert.match(html, /boot-warning/);
    assert.match(html, /id="previous-page"[^>]*>上一页</);
    assert.match(html, /id="next-page"[^>]*>下一页</);
    assert.match(html, /id="current-plate"[^>]*>回到最新</);
    assert.match(client, /dataset\.cakeReady/);
    assert.match(client, /name: 'inspect_cake'/);
    assert.match(client, /name: 'eat_cake_slice'/);
    assert.match(client, /enum: \['previous', 'next', 'latest'\]/);
    pass('页面没有手动重摆入口，并保留加载失败兜底');
  } finally {
    await app.stop();
  }
}

async function verifyPartialConfig() {
  const configDir = await mkdtemp(path.join(tmpdir(), 'cake-on-the-table-config-'));
  const configPath = path.join(configDir, 'cake.config.json');
  await writeFile(configPath, JSON.stringify({ siteTitle: '局部配置也能运行', texts: { hint: '只改一行提示。' } }));
  const app = await startServer({ configPath });
  try {
    const result = await json(app.base, 'GET', '/api/cake');
    assert.equal(result.response.status, 200);
    assert.equal(result.body.config.siteTitle, '局部配置也能运行');
    assert.equal(result.body.config.texts.hint, '只改一行提示。');
    assert.equal(result.body.total, 12);
    assert.ok(result.body.config.texts.boardTitle);
    pass('配置字段缺失时逐项回退，不影响启动');
  } finally {
    await app.stop();
    await rm(configDir, { recursive: true, force: true });
  }
}

await verifyMainServer();
await verifyPartialConfig();
console.log('\nAll cake-on-the-table checks passed.');
