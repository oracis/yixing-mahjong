const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const code = html.match(/<script>([\s\S]*?)<\/script>/)[1];

// ---------- 最小 DOM mock（支持真实事件派发）----------
function makeEl(tag) {
  const el = {
    tag: tag || 'div', _kids: [], style: {}, dataset: {},
    _cls: new Set(), _L: {}, _html: '', _text: '',
    get children() { return el._kids; },
    get className() { return [...el._cls].join(' '); },
    set className(v) { el._cls = new Set(String(v).trim().split(/\s+/).filter(Boolean)); },
    get textContent() { return el._text; },
    set textContent(v) { el._text = String(v); el._kids = []; },
    get innerHTML() { return el._html; },
    set innerHTML(v) { el._html = String(v); el._kids = []; },
    appendChild(c) { el._kids.push(c); c.parent = el; return c; },
    addEventListener(ev, fn) { (el._L[ev] = el._L[ev] || []).push(fn); },
    removeEventListener() {},
    dispatch(ev) { (el._L[ev] || []).forEach(f => f({ target: el, currentTarget: el })); },
    classList: {
      add(...c) { c.forEach(x => el._cls.add(x)); },
      remove(...c) { c.forEach(x => el._cls.delete(x)); },
      toggle(c, f) { if (f === undefined) f = !el._cls.has(c); f ? el._cls.add(c) : el._cls.delete(c); return f; },
      contains(c) { return el._cls.has(c); }
    }
  };
  return el;
}

const byId = {};
global.document = {
  getElementById(id) { return byId[id] || (byId[id] = makeEl('div')); },
  createElement(t) { return makeEl(t); },
  querySelectorAll() { return []; },
  querySelector() { return null; }
};
global.requestAnimationFrame = cb => setTimeout(cb, 16);
global.cancelAnimationFrame = clearTimeout;
global.performance = { now: () => Date.now() };
// 页面会在 window 上挂 resize 监听（布局变了要重算溢出标记）。
// node 的 global 没有 addEventListener，这里手动收一份，测试里可以主动触发。
const winHandlers = {};
global.addEventListener = (ev, fn) => { (winHandlers[ev] = winHandlers[ev] || []).push(fn); };
const fireResize = () => (winHandlers.resize || []).forEach(f => f());

// 关键：不挂这两个钩子的话，setTimeout 里的异常会被静默吞掉
let asyncErrors = [];
process.on('uncaughtException', e => asyncErrors.push(e.message));
process.on('unhandledRejection', e => asyncErrors.push('rej:' + ((e && e.message) || e)));
// 上面挂了 uncaughtException 之后，顶层抛错不会崩进程、只会静默停住 ——
// 曾经因此出现过「PASS/FAIL 一行都不打印但 exit=0」的假绿。退出时强制兜底打印。
process.on('exit', () => { if (asyncErrors.length) console.log('!! 未捕获异常:', asyncErrors.join(' | ')); });

const M = new Function(
  'document', 'window', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance',
  code + '\n;return {Controller,Renderer,MahjongGame,AIPlayer,YixingRules,TileUtils,TileArt};'
)(global.document, global, global.requestAnimationFrame, global.cancelAnimationFrame, global.performance);

const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { pass++; }
  else { fail++; failures.push(msg); }
}
const area = id => global.document.getElementById(id);
const part = (id, cls) => area(id)._kids.find(k => k._cls.has(cls));

(async () => {
  const Y = M.YixingRules, G = M.MahjongGame, T = M.TileUtils, AI = M.AIPlayer;

  // ========== 0. 牌面图形契约 ==========
  // 「牌面数字 = 可数元素个数」是麻将牌最核心的契约，错了肉眼还很难看出来
  // （六条曾排成 2 列×3 行、九条中间一列错成绿竹，都属于这一类）。
  {
    const A = M.TileArt;
    const count = (s, re) => (s.match(re) || []).length;
    for (let n = 2; n <= 9; n++) {
      const p = A.faceHTML('p' + n);
      const dots = count(p, /<circle/g);
      ok(dots === n * 5, `${n}筒应有 ${n} 个圆点（每点 5 层同心圆），实际 ${dots / 5} 个`);
      const s = A.faceHTML('s' + n);
      const sticks = count(s, /<rect/g);
      ok(sticks === n, `${n}条应有 ${n} 根竹，实际 ${sticks} 根`);
    }
    ok(/<ellipse/.test(A.faceHTML('p1')), '一筒应是团花（花瓣环），不应是普通点阵');
    ok(count(A.faceHTML('s1'), /<rect/g) === 0, '一条应是雀鸟，不应画成竹节');
    // 六条是 3 列×2 行、九条是 3×3；两者靠 <rect 的 x 坐标区分
    const xs = s => [...A.faceHTML(s).matchAll(/<rect x="([\d.]+)"/g)].map(m => m[1]);
    ok(new Set(xs('s6')).size === 3, `六条应是 3 列（实际 ${new Set(xs('s6')).size} 列）`);
    ok(new Set(xs('s9')).size === 3, `九条应是 3 列（实际 ${new Set(xs('s9')).size} 列）`);
    // 九条中间一列为红、九筒中间一行为红 —— 红点位不同，容易写反
    ok(count(A.faceHTML('s9'), /#af2b36/g) >= 3, '九条中间一列应为红竹');
    ok(count(A.faceHTML('p9'), /#af2b36/g) >= 3, '九筒中间一行应为红点');
    ok(count(A.faceHTML('s7'), /#af2b36/g) >= 1 && /#2d3d67/.test(A.faceHTML('s7')),
       '七条应是「顶红竹 + 中列藏蓝竹」');
  }

  // ========== 1. 规则引擎 ==========
  ok(Y.getWinningTiles(['m1','m2','m3','m4','m5','m6','p1','p1','p2','p3','s1','s1','s1'], 0).length === 2,
     '双向听应枚举出 2 张');

  const g1 = new G.Game({});
  g1.dealer = 0;
  g1.melds[0] = [{ type:'peng', tiles:['z5','z5','z5'] }, { type:'peng', tiles:['z6','z6','z6'] }];
  g1.hands[0] = ['m1','m1','m1','m9','m9','m9','m5','m5'];
  g1.drawn[0] = null; g1.flowers[0] = ['f1','f2'];
  const c1 = Y.calcFlowers(g1, 0, null, 'zimo');
  ok(c1.win === true, '碰碰胡+混一色应判和');
  ok(c1.patterns.includes('pengpeng') && c1.patterns.includes('hunyise') && !c1.patterns.includes('qingyise'),
     '应含碰碰胡+混一色、不含清一色');
  ok(c1.total === 17, `碰碰胡混一色花数应 17，实际 ${c1.total}`);

  const g2 = new G.Game({});
  g2.dealer = 0; g2.melds[0] = []; g2.flowers[0] = [];
  g2.hands[0] = ['m1','m1','m1','m2','m2','m2','m3','m3','m3','m4','m5','m6','m7','m7'];
  g2.drawn[0] = 'm7';
  const c2 = Y.calcFlowers(g2, 0, null, 'zimo');
  ok(c2.patterns.includes('qingyise') && !c2.patterns.includes('hunyise'), '纯万清一色不应含混一色');
  ok(c2.total === 11, `清一色门清花数应 11，实际 ${c2.total}`);

  // ========== 2. 一圈限制 ==========
  const g3 = new G.Game({});
  g3.hands[1] = ['m5','m5','m1','m2','m3','p4','p5','s7','s8','s9','z1','z2','z3'];
  ok(g3.canPeng(1, 'm5') === true, '放弃前应可碰');
  g3.declinedPon[1].add('m5');
  ok(g3.canPeng(1, 'm5') === false, '放弃碰后一圈内不应可碰');
  g3.drawTile(1);
  ok(g3.declinedPon[1].size === 0, '自己摸牌后一圈限制应清除');
  ok(g3.canPeng(1, 'm5') === true, '清档后应恢复可碰');

  // ========== 3. 手牌排序（所有变更点）==========
  const isSorted = hand => {
    for (let i = 1; i < hand.length; i++) if (T.sortKey(hand[i]) < T.sortKey(hand[i-1])) return false;
    return true;
  };
  const g4 = new G.Game({});
  g4.hands[1] = ['s9','m1','p5','s9','m1','p5','z2','z2','m7','s3','p8','m4','s6'];
  g4.drawTile(1);
  ok(isSorted(g4.hands[1]), '摸牌后手牌应有序');
  g4.hands[2] = ['s9','p3','p3','m1','m2','m3','s4','s5','s6','p9','m7','z3','z4'];
  g4.doPeng(2, 'p3');
  ok(isSorted(g4.hands[2]), '碰后手牌应有序');
  ok(g4.hands[2].length === 11, `碰后应 11 张，实际 ${g4.hands[2].length}`);
  g4.hands[3] = ['m5','m3','m4','s1','s2','s9','p7','p8','z1','z2','m9','s8','s6'];
  g4.doChi(3, ['m3','m4'], 'm5');
  ok(isSorted(g4.hands[3]), '吃后手牌应有序');

  // ========== 4. AI 人格 ==========
  AI.assignPersonas('random');
  ok(new Set([AI.personaName(1), AI.personaName(2), AI.personaName(3)]).size === 3, '随机分配三家人格应互不相同');
  AI.assignPersonas('all-aggressive');
  ok(AI.personaName(1) === '激进' && AI.personaName(3) === '激进', '全激进应生效（含 all- 前缀剥离）');
  AI.assignPersonas('all-conservative');
  ok(AI.personaName(1) === '保守', '全保守应生效');

  const g5 = new G.Game({});
  g5.hands[1] = ['m5','m5','m1','m2','m3','p7','p8','p9','s2','s3','s4','z1','z6'];
  AI.assignPersonas('all-conservative');
  ok(AI.decidePon(g5, 1, 'm5', false) === false, '保守型持平非字牌碰应为 false');
  AI.assignPersonas('all-aggressive');
  let agreed = 0;
  for (let i = 0; i < 300; i++) if (AI.decidePon(g5, 1, 'm5', false)) agreed++;
  ok(agreed / 300 > 0.7, `激进型持平碰同意率应 >0.7，实际 ${(agreed/300).toFixed(2)}`);

  AI.assignPersonas('all-conservative');
  g5.hands[1] = ['m5','m5','m5','m6','m7','p1','p2','p3','s4','s5','s6','z1','z2'];
  ok(AI.decidePon(g5, 1, 'm5', false) === true, '减向听时保守型也必须碰');

  // ========== 4b. AI 节奏（出牌快慢直接决定手感，必须有回归防线）==========
  // 依据见 index.html 的 AI_PACE 注释：玩家感知的是「停顿」而非 AI 算得多快，
  // 参考雀魂（每动作 +1~2s 动画）、天凤（5s/巡）、皇家学会实验（感知等待 ~1s）。
  {
    const pace = M.Controller.pace;
    const sample = (key, n) => { const a = []; for (let i = 0; i < n; i++) a.push(pace.for(key)); return a; };
    const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
    const lo = a => Math.min(...a), hi = a => Math.max(...a);

    // 摸牌后→出牌：玩家感知最强的停顿，下限必须抬到 850ms（旧值 420ms 被反馈"太快"）
    const d = sample('drawToThink', 400);
    ok(lo(d) >= 850, `AI 摸牌思考下限应 ≥850ms，实际 ${lo(d)}`);
    ok(hi(d) <= 2400, `AI 摸牌思考上限应 ≤2400ms（长考封顶），实际 ${hi(d)}`);
    ok(mean(d) >= 1100 && mean(d) <= 1700,
       `AI 摸牌思考均值应落在 1.1~1.7s，实际 ${Math.round(mean(d))}ms`);
    // 长考分支要有、但不能变成常态，否则整局拖沓
    const longs = d.filter(x => x >= 1500).length;
    ok(longs > 0, '应存在长考（≥1500ms）分支，否则三家像同一个节拍器');
    ok(longs < d.length * 0.4, `长考不应成为常态（占比应 <40%，实际 ${Math.round(longs / d.length * 100)}%）`);

    ok(sample('claim', 80).every(x => x >= 650 && x <= 1100), 'AI 反应碰/杠/吃应在 650~1100ms');
    ok(sample('settle', 80).every(x => x >= 800 && x <= 1150), '和牌/抢杠结算停顿应在 800~1150ms');
    ok(sample('thinkToMove', 80).every(x => x >= 500 && x <= 850), '落子停顿应在 500~850ms');
    // 未登记的 key 回落 thinkToMove（且不能顺带吃到长考分支）
    ok(sample('no-such-key', 80).every(x => x >= 500 && x <= 850), '未登记的 key 应回落 thinkToMove 区间');

    // 难度真的会改节奏——旧版 speed() 是恒返回 1 的死代码，等于三档没差别
    pace.setLevel('easy'); const e = mean(sample('thinkToMove', 300));
    pace.setLevel('hard'); const h = mean(sample('thinkToMove', 300));
    ok(h > e * 1.1, `困难档应明显慢于简单档（easy≈${Math.round(e)}ms hard≈${Math.round(h)}ms）`);
    // 非法档位必须被忽略；若放行会算出 NaN → setTimeout(fn,NaN) 退化成 0＝瞬发
    pace.setLevel('bogus');
    ok(Math.abs(mean(sample('thinkToMove', 300)) - h) < h * 0.2, '非法难度档不应改变节奏（更不该变成 NaN）');
    pace.setLevel('normal');
    ok(sample('drawToThink', 200).every(x => x >= 765 && x <= 2400), '回到普通档后应落在基准区间');
  }

  // ========== 5. 端到端：真实点击驱动整局 ==========
  M.Controller.init({ difficulty:'normal', persona:'random' });
  M.Controller.startNewRound();
  await sleep(300);

  // 四个座位的信息条都要渲染（旧版在窄屏用 display:none 把南/北两家整个删掉）。
  // 注意：信息条是用 innerHTML 写的，DOM mock 不解析 HTML，所以查 _html 而不是 _kids
  for (const id of ['head-south','head-east','head-north','head-west']) {
    const h = area(id);
    ok(/花\d/.test(h._html), `${id} 信息条应渲染出「花N」（实际：${h._html.slice(0,60)}）`);
  }
  // 对家 + 上下家的牌背都要渲染出来（三家的手牌一张都不能藏）
  for (const id of ['backs-north','backs-east','backs-west']) {
    ok(area(id)._kids.length > 0, `${id} 应渲染出牌背`);
  }
  // 自己的手牌必须渲染，且牌数 = 手上真实张数
  ok(area('hand-area')._kids.length > 0, '自己的手牌应渲染出来');
  // 四家弃牌都必须落在中央牌河的四个格子里，而不是各自的弃牌墙
  for (const id of ['discard-south','discard-east','discard-north','discard-west']) {
    ok(area(id) && area(id)._kids !== undefined, `${id} 弃牌格应存在（中央共享牌河）`);
  }

  // 自动打完整局：优先点动作按钮，否则点手牌。
  // 预算是「按 AI 节奏反推」而不是写死的：一巡多长完全由 AI_PACE 决定，
  // 出牌调快调慢都得跟着变，否则一改节奏这条断言就假红（调慢后确实红过一次）。
  const paceRef = M.Controller.pace;
  const meanMs = (key, n) => { let s = 0; for (let i = 0; i < n; i++) s += paceRef.for(key); return s / n; };
  const oneTurn = 320 + meanMs('drawToThink', 200);   // 320 = scheduleLoop 的轮询间隔
  // 要验证 played>5 至少得走 6 个来回，每个来回三家 AI 各一巡；再留 1.5 倍余量给碰/杠/吃
  const budget = Math.round(3 * oneTurn * 6 * 1.5);
  const deadline = Date.now() + budget;
  console.log(`[e2e] 单巡≈${Math.round(oneTurn)}ms，循环预算 ${(budget / 1000).toFixed(1)}s`);
  const PRIO = ['自摸','和（荣和）','和','抢杠','杠','碰','吃'];
  let played = 0, acted = 0, centerChecked = false;
  for (let i = 0; i < 4000 && Date.now() < deadline; i++) {
    const bar = global.document.getElementById('action-bar');
    if (bar._kids.length) {
      let pick = null;
      for (const kw of PRIO) { pick = bar._kids.find(b => b.textContent.indexOf(kw) === 0); if (pick) break; }
      if (!pick) pick = bar._kids[bar._kids.length - 1];
      pick.dispatch('click'); acted++;
      await sleep(110);
      continue;
    }
    const hand = area('hand-area');
    const disc = area('discard-south');
    if (hand && hand._kids.length) {
      const before = disc._kids.length;
      hand._kids[0].dispatch('click');
      await sleep(95);
      if (disc._kids.length > before) {
        played++;
        // 中央那块（放大显示「谁打出了什么」）必须就在这一次出牌后校验：
        // 等到整局打完再查，对局可能已经结束、lastDiscard 被清空，断言会随机翻车。
        if (!centerChecked) {
          centerChecked = true;
          const ld = area('last-discard');
          ok(ld._kids.length === 2,
             `中央应渲染「谁打出 + 放大的牌」两块（实际 ${ld._kids.length}）`);
          ok(ld._kids[0] && /打出/.test(ld._kids[0].textContent),
             `中央应写明是谁打出（实际：${ld._kids[0] && ld._kids[0].textContent}）`);
        }
      }
    }
    await sleep(70);
    const rb = byId['result-btn'];
    if (rb && rb.style.display === 'block') break;
  }
  ok(played > 0, `玩家应能成功出牌，实际 ${played} 次`);
  ok(acted > 0 || played > 5, `对局应推进（出牌 ${played} 次，动作 ${acted} 次）`);

  // 后期（每家 >22 张弃牌）牌河要挂上 tight，自动缩一档给中央让位
  const game = M.Controller.game;
  const maxDisc = Math.max(...[0,1,2,3].map(p => game.discards[p].length));
  const river = byId['river'];
  ok(river.classList.contains('tight') === (maxDisc > 22),
     `#river 的 tight 档应与弃牌数一致（最多 ${maxDisc} 张，tight=${river.classList.contains('tight')}）`);
  // 中央「最后打出」那块在出牌瞬间校验过（见上面的 centerChecked）
  ok(centerChecked, '整局中应至少完成一次出牌，否则无法验证中央那块');

  // 四家弃牌格都应有牌（说明「弃牌 → 中央牌河」全链路通）
  for (const id of ['discard-south','discard-east','discard-north','discard-west']) {
    const n = area(id)._kids.length;
    if (n === 0) failures.push(`提示：${id} 弃牌格为空（可能是本局尚未轮到，非致命）`);
  }

  // ========== 点侧列 → 该家弃牌浮层 ==========
  // 横屏侧列物理上放不下全部弃牌（20 张旋转牌要 480px，横屏牌河仅 ~147px），
  // 只能靠「点开看全部」补。这里验证入口、内容、关闭三件事。
  const peek = byId['peek-modal'];
  const seatE = byId['seat-east'], seatW = byId['seat-west'];

  seatE.dispatch('click');
  ok(peek.classList.contains('show'), '点东家侧列应弹出弃牌浮层');
  const peekDisc = byId['peek-discards'];
  ok(peekDisc._kids.length === game.discards[1].length,
     `浮层弃牌数应等于东家弃牌数（浮层 ${peekDisc._kids.length} vs 实际 ${game.discards[1].length}）`);
  ok(byId['peek-count'].textContent === String(game.discards[1].length),
     `浮层计数应等于东家弃牌数（实际 ${byId['peek-count'].textContent}）`);
  // 标题格式：「南·AI（均衡） · 南 · 花2 · +0」。
  // 第一个是玩家名（全项目约定用 WINDS[p]，与 toast 一致），第二个是本局风位（随庄家变）
  const peekTitle = byId['peek-title'].textContent;
  ok(/AI/.test(peekTitle) && /花\d+/.test(peekTitle) && /[东南西北]/.test(peekTitle),
     `浮层标题应写明「谁 + 花数 + 风位」（实际：${peekTitle}）`);
  // 浮层里的牌必须是可辨认的正常尺寸（不能被 #river 的 mini 尺寸带小）
  ok(!/mini/.test(peekDisc._kids[0] ? peekDisc._kids[0].className : ''),
     '浮层里的牌不应带 mini 类（否则等于没放大）');

  byId['peek-close'].dispatch('click');
  ok(!peek.classList.contains('show'), '点关闭按钮应收起浮层');

  // 点西家侧列 → 应切到 p3 的内容
  seatW.dispatch('click');
  ok(peek.classList.contains('show'), '点西家侧列也应弹出浮层');
  ok(byId['peek-discards']._kids.length === game.discards[3].length,
     `西家浮层弃牌数应等于 p3（浮层 ${byId['peek-discards']._kids.length} vs 实际 ${game.discards[3].length}）`);
  // 点遮罩（事件 target 是浮层根节点本身）应关闭
  peek.dispatch('click');
  ok(!peek.classList.contains('show'), '点遮罩应收起浮层');

  // 「看全部」提示已并入座位信息条（金色药丸，有弃牌才渲染）。
  // chip 是 innerHTML 写的，DOM mock 不解析 HTML，所以查 _html 而不是子节点。
  const headHtml = byId['head-east']._html || '';
  ok(game.discards[1].length > 0 && /more-chip"[^>]*>▸看全部</.test(headHtml),
     `东家信息条应含「▸看全部」药丸（html="${headHtml}"）`);
  // ---------- 溢出收口（弃牌整行化 / 中央格收起）----------
  // mock 没有布局引擎，clientHeight/scrollHeight/offsetHeight 一直是 undefined；
  // 手动塞进去再触发 resize，验证「只有装不下才收口」这条判据。
  ok((winHandlers.resize || []).length > 0, '应监听 window resize 以重算溢出收口');
  const dw = byId['discard-west'], ci = byId['center-info'];
  // 造一个「行高 20、可用 300、内容 400」的格子：能放 13 整行 = 13*22-2 = 284px
  dw.children.length = 0;
  dw.appendChild({ offsetHeight: 20 });
  dw.clientHeight = 300; dw.scrollHeight = 400; ci.clientHeight = 80;
  fireResize();
  ok(dw.classList.contains('snap') && dw.style.height === '284px',
     `弃牌区装不下时应收口到整行数（实际 height="${dw.style.height}" class=${dw.className}）`);
  ok(ci.classList.contains('narrow'), '中央格 <110px 时应收起「最后打出」');
  // 装得下 → 必须保持原样，否则会平白少显示一行
  dw.scrollHeight = 300; ci.clientHeight = 300;
  fireResize();
  ok(!dw.classList.contains('snap') && !dw.style.height,
     '装得下时不应收口（否则平白少显示一行）');
  ok(!ci.classList.contains('narrow'), '中央格够高时不应收起「最后打出」');
  // 极端矮：可用高度连一行都放不下 → 不能收口（写死高度会顶出容器反被裁）
  dw.clientHeight = 10; dw.scrollHeight = 400;
  fireResize();
  ok(!dw.classList.contains('snap') && !dw.style.height,
     '可用高度不足一行时不应收口');

  ok(asyncErrors.length === 0, `不应有异步异常，实际：${[...new Set(asyncErrors)].join(' | ')}`);

  // ---------- 汇总 ----------
  console.log('');
  if (failures.length) {
    console.log('提示信息：');
    failures.filter(f => f.startsWith('提示：')).forEach(f => console.log('  ' + f));
  }
  const realFailures = failures.filter(f => !f.startsWith('提示：'));
  if (realFailures.length) {
    console.log('失败项：');
    realFailures.forEach(f => console.log('  ✗ ' + f));
  }
  console.log(`\n出牌 ${played} 次 | 动作按钮 ${acted} 次 | 异步异常 ${asyncErrors.length}`);
  console.log(`PASS=${pass} FAIL=${fail}`);
  process.exit(fail ? 1 : 0);
})();
