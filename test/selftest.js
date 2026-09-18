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

// 关键：不挂这两个钩子的话，setTimeout 里的异常会被静默吞掉
let asyncErrors = [];
process.on('uncaughtException', e => asyncErrors.push(e.message));
process.on('unhandledRejection', e => asyncErrors.push('rej:' + ((e && e.message) || e)));

const M = new Function(
  'document', 'window', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance',
  code + '\n;return {Controller,Renderer,MahjongGame,AIPlayer,YixingRules,TileUtils};'
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

  // ========== 5. 端到端：真实点击驱动整局 ==========
  M.Controller.init({ difficulty:'normal', persona:'random' });
  M.Controller.startNewRound();
  await sleep(300);

  // 四个座位都必须渲染出来
  for (const id of ['area-south','area-east','area-north','area-west']) {
    ok(area(id)._kids.length > 0, `${id} 应渲染出子节点`);
  }
  // 左右两侧弃牌区必须在手牌内侧
  const eastRow = part('area-east', 'side-row');
  const westRow = part('area-west', 'side-row');
  ok(!!eastRow && !!westRow, '左右两侧应有 side-row 容器');
  if (eastRow) {
    ok(eastRow._kids[0]._cls.has('discard-area') && eastRow._kids[1]._cls.has('hand-area'),
       '右侧（南）弃牌区应在手牌左侧（内侧）');
  }
  if (westRow) {
    ok(westRow._kids[0]._cls.has('hand-area') && westRow._kids[1]._cls.has('discard-area'),
       '左侧（北）弃牌区应在手牌右侧（内侧）');
  }

  // 自动打完整局：优先点动作按钮，否则点手牌
  const PRIO = ['自摸','和（荣和）','和','抢杠','杠','碰','吃'];
  let played = 0, acted = 0;
  for (let i = 0; i < 180; i++) {
    const bar = global.document.getElementById('action-bar');
    if (bar._kids.length) {
      let pick = null;
      for (const kw of PRIO) { pick = bar._kids.find(b => b.textContent.indexOf(kw) === 0); if (pick) break; }
      if (!pick) pick = bar._kids[bar._kids.length - 1];
      pick.dispatch('click'); acted++;
      await sleep(110);
      continue;
    }
    const hand = part('area-south', 'hand-area');
    const disc = part('area-south', 'discard-area');
    if (hand && hand._kids.length) {
      const before = disc ? disc._kids.length : 0;
      hand._kids[0].dispatch('click');
      await sleep(95);
      const after = part('area-south', 'discard-area');
      if (after && after._kids.length > before) played++;
    }
    await sleep(70);
    const rb = byId['result-btn'];
    if (rb && rb.style.display === 'block') break;
  }
  ok(played > 0, `玩家应能成功出牌，实际 ${played} 次`);
  ok(acted > 0 || played > 5, `对局应推进（出牌 ${played} 次，动作 ${acted} 次）`);

  // 四家弃牌区都应有牌（说明渲染全链路通）
  for (const id of ['area-south','area-east','area-north','area-west']) {
    const d = part(id, 'discard-area');
    const n = d ? d._kids.length : 0;
    if (n === 0) failures.push(`提示：${id} 弃牌区为空（可能是本局尚未轮到，非致命）`);
  }
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
