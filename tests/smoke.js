// 上线前冒烟测试：node tests/smoke.js
// 用无头浏览器加载游戏，让机器人把每一关打一遍，并检查关卡生成、存档、兼容性和离线缓存。
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');

const ROOT = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  let file = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  fs.readFile(file, (err, buf) => { if (err) { res.writeHead(404); return res.end('not found'); } res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' }); res.end(buf); });
});

// 在页面里运行的辅助函数
const helpers = () => {
  // 会看路的机器人：沿安全航线走，前方有漂木或礁石挡路就换一条线，都走不通就先减速
  window.botKeys = (look, margin, horizon) => {
    const g = window.__raft, r = g.raft, I = g.input, L = g.level; I.L = I.R = I.U = I.B = I.S = false;
    const safe = g.safeX(r.d + look), c = g.riverCx(r.d + look), w = g.riverW(r.d + look) - 16;
    const nearDrop = L.drops.some(q => q.d - r.d > -40 && q.d - r.d < 200);
    const rockBad = x => Math.abs(x - safe) > 20 && L.rocks.some(k => k.d > r.d - 10 && k.d < r.d + horizon && Math.abs(k.x - x) < k.r + 24);
    const logBad = x => L.logs.some(l => l.on && l.d - r.d > -30 && l.d - r.d < 190 && Math.abs(l.x - x) < Math.abs(Math.cos(l.rot)) * l.len + margin);
    const cands = [safe]; if (!nearDrop) for (let o = 20; o <= 160; o += 20) cands.push(safe - o, safe + o);
    let tx = null; for (const x of cands) { if (x < c - w || x > c + w) continue; if (!logBad(x) && !rockBad(x)) { tx = x; break; } }
    const coast = tx === null && !nearDrop; if (tx === null) tx = safe;
    const e = Math.atan2(tx - r.x, look) - r.a;
    if (e > 0.08) I.R = true; else if (e < -0.08) I.L = true; else if (!coast) I.U = true;
    if (coast) I.B = true;
  };
  window.play = (lvl, mode, look = 60, margin = 30, horizon = 130) => {
    const g = window.__raft; g.setManual(true); g.start(true, lvl); let n = 0;
    while (g.state === 'play' && n++ < 120 * 240) { if (mode === 'bot') window.botKeys(look, margin, horizon); else Object.keys(g.input).forEach(k => g.input[k] = false); g.step(); }
    const r = g.raft, out = { state: g.state, hits: r.hits, coins: r.coins, total: g.level.coins.length, time: +r.time.toFixed(2), d: Math.round(r.d), stars: g.state === 'win' ? g.result.stars : 0, score: g.state === 'win' ? g.result.score : 0 };
    Object.keys(g.input).forEach(k => g.input[k] = false); g.setManual(false); return out;
  };
  // 随机乱按：检查数值不会坏掉、艇不会出河道、不会卡死
  window.fuzz = (runs, levels) => {
    const g = window.__raft, bad = []; g.setManual(true); let seed = 2024; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
    for (let run = 0; run < runs; run++) {
      const lvl = run % levels; g.start(true, lvl); let n = 0; const held = {};
      while (g.state === 'play' && n++ < 120 * 170) {
        if (n % 20 === 0) for (const k of ['L', 'R', 'U', 'B', 'S']) held[k] = rnd() < (k === 'U' ? 0.6 : k === 'B' ? 0.08 : 0.3);
        Object.assign(g.input, held); g.step();
        const r = g.raft, c = g.riverCx(r.d), w = g.riverW(r.d);
        if (![r.x, r.d, r.vx, r.vd, r.a, r.av].every(Number.isFinite)) { bad.push(`第${lvl + 1}关 出现 NaN`); break; }
        if (Math.abs(r.x - c) > w + 6) { bad.push(`第${lvl + 1}关 d=${r.d | 0} 艇出了河道`); break; }
        if (Math.hypot(r.vx, r.vd) > 900) { bad.push(`第${lvl + 1}关 d=${r.d | 0} 速度异常`); break; }
        if (r.hp < 0 || r.hp > 3) { bad.push(`第${lvl + 1}关 气囊数异常`); break; }
      }
      if (g.state === 'play') bad.push(`第${lvl + 1}关 d=${g.raft.d | 0} 卡死（170 秒没有结束）`);
    }
    Object.keys(g.input).forEach(k => g.input[k] = false); g.setManual(false); return bad;
  };
  // 关卡生成的硬性约束
  window.checkLevel = lvl => {
    const g = window.__raft; g.start(true, lvl); const L = g.level, bad = [];
    for (const r of L.rocks) {
      const gap = g.riverW(r.d) - Math.abs(r.x - g.riverCx(r.d)) - r.r;
      if (!r.gate && gap > 2 && gap < 24) bad.push(`礁石 d=${r.d | 0} 与河岸之间有 ${gap | 0}px 的窄缝`);
    }
    for (const c of L.coins) {
      for (const r of L.rocks) if (Math.hypot(r.x - c.x, r.d - c.d) < r.r + 24) bad.push(`莲花 d=${c.d} 离礁石太近`);
      for (const v of L.whirls) if (Math.hypot(v.x - c.x, v.d - c.d) < 60) bad.push(`莲花 d=${c.d} 在漩涡中心附近`);
      if (Math.abs(c.x - g.riverCx(c.d)) > g.riverW(c.d) - 24) bad.push(`莲花 d=${c.d} 太靠岸`);
    }
    for (const q of L.drops) if (Math.abs(q.x - g.safeX(q.d)) > 1) bad.push(`跌水 d=${q.d} 的水舌不在安全航线上`);
    return bad;
  };
};

const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ' — ' + detail : ''}`); };

(async () => {
  await new Promise(r => server.listen(0, r));
  const base = `http://localhost:${server.address().port}/`;
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const newPage = async (opts = {}, init) => {
    const ctx = await browser.newContext({ viewport: { width: 420, height: 800 }, ...opts });
    await ctx.addInitScript(helpers); if (init) await ctx.addInitScript(init);
    const page = await ctx.newPage(); page.errors = [];
    page.on('pageerror', e => page.errors.push(e.message)); page.on('console', m => m.type() === 'error' && page.errors.push(m.text()));
    await page.goto(base); await page.waitForFunction(() => window.__raft); return page;
  };

  console.log('启动');
  let page = await newPage();
  check('页面加载无报错', page.errors.length === 0, page.errors.join(' | '));
  check('加载提示已移除', await page.locator('#loading').count() === 0);
  check('选关界面有全部关卡，后续关卡默认上锁', await page.locator('.lv').count() >= 3 && await page.locator('.lv.locked').count() === await page.locator('.lv').count() - 1);
  const levels = await page.locator('.lv').count();

  for (let lvl = 0; lvl < levels; lvl++) {
    console.log(`第 ${lvl + 1} 关`);
    const bad = await page.evaluate(l => window.checkLevel(l), lvl);
    check('关卡生成满足约束', bad.length === 0, bad.slice(0, 3).join('；'));
    let wins = 0, clean = 0, best = 0;
    for (const look of [50, 60, 70]) for (const margin of [28, 36]) for (const horizon of [110, 150]) {
      const r = await page.evaluate(a => window.play(a[0], 'bot', a[1], a[2], a[3]), [lvl, look, margin, horizon]);
      if (r.state === 'win') { wins++; best = Math.max(best, r.score); if (r.hits === 0) clean++; }
    }
    check('机器人能稳定通关', wins >= 10, `${wins}/12 通关`);
    check('零碰撞满评价可达成', clean >= 1, `${clean}/12 零碰撞，最高 ${best} 分`);
    // 教学关允许随波逐流勉强漂到终点，但只能拿 1 朵莲花；之后的关卡不操作必沉
    const idle = await page.evaluate(l => window.play(l, 'idle'), lvl);
    if (lvl === 0) check('不操作最多 1 朵', idle.stars <= 1, idle.state === 'win' ? `${idle.time} 秒漂到终点，${idle.stars} 朵` : `漂到 ${idle.d} 处沉没`);
    else check('不操作无法通关', idle.state === 'dead', `漂到 ${idle.d} 处${idle.state === 'dead' ? '沉没' : '：' + idle.state}`);
    const a = await page.evaluate(l => window.play(l, 'bot'), lvl), b = await page.evaluate(l => window.play(l, 'bot'), lvl);
    check('同样的操作得到同样的结果', a.time === b.time && a.score === b.score && a.hits === b.hits, `${a.time}s/${a.score} 对 ${b.time}s/${b.score}`);
  }

  console.log('健壮性');
  const fuzz = await page.evaluate(n => window.fuzz(45, n), levels);
  check('随机乱按 45 局：无数值异常、不出河道、不卡死', fuzz.length === 0, fuzz.slice(0, 4).join('；'));
  check('以上全程无报错', page.errors.length === 0, page.errors.slice(0, 2).join(' | '));
  await page.context().close();

  console.log('界面流程（实时）');
  page = await newPage();
  await page.click('#go'); await page.waitForFunction(() => window.__raft.state === 'play', null, { timeout: 8000 });
  check('点击出发 → 倒计时 → 开始', true);
  await page.keyboard.down('ArrowUp'); await page.waitForTimeout(700); await page.keyboard.up('ArrowUp');
  check('键盘划桨有效', await page.evaluate(() => window.__raft.raft.d > -60));
  await page.keyboard.press('p'); const d1 = await page.evaluate(() => window.__raft.raft.d); await page.waitForTimeout(300);
  check('暂停后游戏停住', await page.evaluate(() => window.__raft.state) === 'pause' && d1 === await page.evaluate(() => window.__raft.raft.d));
  await page.click('button.alt:has-text("设置")'); await page.click('.opt[data-k="sens"][data-v="2"]'); await page.click('#go');
  check('暂停里改设置后回到暂停', await page.evaluate(() => window.__raft.state) === 'pause' && await page.evaluate(() => window.__raft.cfg.sens) === 2);
  await page.reload(); await page.waitForFunction(() => window.__raft);
  check('设置刷新后仍在', await page.evaluate(() => window.__raft.cfg.sens) === 2);
  // 冲线后立刻重开，成绩也必须已经存下
  await page.evaluate(() => { const g = window.__raft; g.setManual(true); g.start(true, 0); let n = 0; while (g.state === 'play' && n++ < 40000) { window.botKeys(60, 30, 130); g.step(); } });
  check('冲线瞬间即存档', await page.evaluate(() => window.__raft.state === 'win' && !!localStorage.getItem('raft_l1_best')));
  await page.evaluate(() => window.__raft.setManual(false)); await page.waitForSelector('#go:has-text("下一关")', { timeout: 6000 });
  await page.click('button.alt:has-text("选关")');
  check('通关第一关后第二关解锁', await page.locator('.lv.locked').count() === levels - 2);
  await page.keyboard.press('2'); check('数字键选关', await page.evaluate(() => window.__raft.level.id) === 2);
  check('界面流程无报错', page.errors.length === 0, page.errors.slice(0, 2).join(' | '));
  await page.context().close();

  console.log('兼容性与布局');
  page = await newPage({}, () => { delete CanvasRenderingContext2D.prototype.roundRect; });
  await page.evaluate(() => { const g = window.__raft; g.setManual(true); g.start(true, 0); for (let i = 0; i < 3000; i++) { window.botKeys(60, 30, 130); g.step(); if (i % 30 === 0) g.draw(); } });
  check('没有 roundRect 的旧浏览器也能运行', page.errors.length === 0 && await page.evaluate(() => typeof CanvasRenderingContext2D.prototype.roundRect === 'function'), page.errors.slice(0, 2).join(' | '));
  await page.context().close();
  page = await newPage({ viewport: { width: 320, height: 568 }, hasTouch: true, isMobile: true });
  const fit = async () => page.evaluate(() => { const p = document.getElementById('panel').getBoundingClientRect(), w = document.getElementById('wrap').getBoundingClientRect(); return p.top >= w.top - 1 && p.bottom <= w.bottom + 1 && p.left >= 0 && p.right <= innerWidth; });
  check('小屏手机（320×568）选关面板不溢出', await fit());
  await page.tap('button.alt'); check('小屏手机设置面板不溢出', await fit());
  await page.context().close();

  console.log('离线');
  page = await newPage();
  const sw = await page.evaluate(() => navigator.serviceWorker.ready.then(() => true).catch(() => false));
  await page.waitForFunction(() => caches.open('rafting-v2').then(c => c.keys()).then(k => k.length >= 3), null, { timeout: 8000 }).catch(() => {});
  await page.context().setOffline(true);
  let offlineOk = false;
  try { await page.reload(); await page.waitForFunction(() => window.__raft, null, { timeout: 8000 }); offlineOk = true; } catch (e) {}
  check('离线缓存就绪后断网仍能打开', sw && offlineOk);
  await page.context().close();

  await browser.close(); server.close();
  const failed = results.filter(ok => !ok).length;
  console.log(failed ? `\n${failed} 项未通过` : `\n全部 ${results.length} 项通过`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
