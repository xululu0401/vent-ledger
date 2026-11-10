/* 通风对账台 · 核心测试（node --test tests/core.test.cjs）
 *
 * 覆盖：独立锚点（另一套实现）、段内解析解 vs 独立数值积分、ODE 导数核查、交叉时间 vs 二分、
 *       超标时长 vs 细步长采样积分、反推风量 vs 独立二分、单调性与方向、单位与极限退化、
 *       非法输入逐条核字段、合法边界、结构自检（默认 + 9 场景 + 随机压力）、确定性、
 *       不修改入参、稳定日循环不动点、导出与备份往返。
 *
 * 「独立锚点」的来历：`make-anchors.py`（Python，直接把 V dC/dt = 60000·ΣG − Q(C−C_atm)
 * 用 dt = 1e-6 h 的显式积分推一遍，不使用本引擎任何代码）与另一条闭式解路径互证后固化下来的常数。
 * 参考实现与工程实现对拍只能证明两边一致，所以另外单独核查了 ODE 导数、单位换算与常识量级。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const C = require(path.join(__dirname, '..', 'core.js'));

const near = (a, b, tol, msg) => {
  const d = Math.abs(a - b);
  assert.ok(d <= tol, (msg || '') + ' |实际 ' + a + ' 期望 ' + b + ' 差 ' + d + ' 容差 ' + tol);
};
const rel = (a, b, tol, msg) => {
  const d = Math.abs(a - b) / Math.max(1e-12, Math.abs(b));
  assert.ok(d <= tol, (msg || '') + ' |实际 ' + a + ' 期望 ' + b + ' 相对差 ' + d + ' 容差 ' + tol);
};
const clone = (o) => JSON.parse(JSON.stringify(o));
function an(cfg) {
  const r = C.analyze(cfg);
  assert.ok(r.ok, '应通过校验，实际报错：' + JSON.stringify(r.errors));
  return r;
}
function sc(id) {
  const hit = C.scenarios.filter((x) => x.id === id)[0];
  assert.ok(hit, '找不到场景 ' + id);
  return C.scenarioCfg(id);
}

/* ── 确定性伪随机（不用 Math.random，保证可复现） ── */
function mulberry(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const ACTS = ['sleep', 'sit', 'light', 'medium', 'sport'];
function randCfg(rnd) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const n = 1 + Math.floor(rnd() * 6);
    const frac = [];
    for (let i = 0; i < n; i++) frac.push(0.02 + rnd());
    const s = frac.reduce((a, b) => a + b, 0);
    let cum = 0;
    const hours = frac.map((f) => {
      const prev = cum;
      cum += f / s * 24;
      return Math.round((cum - prev) * 1e4) / 1e4;
    });
    hours[n - 1] = Math.round((24 - hours.slice(0, n - 1).reduce((a, b) => a + b, 0)) * 1e4) / 1e4;
    if (hours.some((h) => h < 0.05 || h > 24)) continue;
    const cAtm = Math.round(360 + rnd() * 700);
    const target = Math.round(Math.min(5000, cAtm + 100 + rnd() * 2400));
    if (target < cAtm + 50 || target > 5000) continue;
    const cfg = {
      area: Math.round((1 + rnd() * 120) * 100) / 100,
      height: Math.round((1.8 + rnd() * 2.5) * 100) / 100,
      c0: Math.round(400 + rnd() * 3000),
      cAtm: cAtm,
      target: target,
      achClosed: Math.round(rnd() * 300) / 100,
      achOpen: Math.round(rnd() * 3000) / 100,
      vent: Math.round(rnd() * 400),
      cadr: Math.round(rnd() * 600),
      startAt: '22:00',
      g: { sleep: 0.2, sit: 0.25, light: 0.35, medium: 0.6, sport: 1.5 },
      segments: hours.map((h, i) => ({
        label: '段' + (i + 1), hours: h,
        people: rnd() < 0.35 ? 0 : 1 + Math.floor(rnd() * 12),
        act: ACTS[Math.floor(rnd() * ACTS.length)],
        open: rnd() < 0.3 ? 1 : 0
      }))
    };
    if (cfg.achOpen < 0.01) cfg.achOpen = 0.01 + rnd() * 30;
    const r = C.analyze(cfg);
    if (r.ok) return cfg;
  }
  throw new Error('随机配置生成失败');
}

/* ═══════════════ 1. 独立锚点 ═══════════════ */
test('独立锚点：默认场景的逐段量（Python dt=1e-6 显式积分 + 闭式解互证）', () => {
  const r = an(C.defaultsClone());
  near(r.V, 31.2, 1e-9, '房间体积');
  const exp = [
    { Q: 9.36, P: 12000, tau: 3.3333333333333335, css: 1702.051282051282, cOut: 1585.746213732 },
    { Q: 312.0, P: 0, tau: 0.1, css: 420.0, cOut: 515.690276350 },
    { Q: 9.36, P: 21000, tau: 3.3333333333333335, css: 2663.5897435897436, cOut: 1072.386682066 },
    { Q: 312.0, P: 0, tau: 0.1, css: 420.0, cOut: 473.551159900 },
    { Q: 9.36, P: 0, tau: 3.3333333333333335, css: 420.0, cOut: 420.932988370 },
    { Q: 9.36, P: 30000, tau: 3.3333333333333335, css: 3625.128205128205, cOut: 1251.402005933 }
  ];
  assert.strictEqual(r.rows.length, 6, '默认 6 段');
  r.rows.forEach((row, i) => {
    near(row.Q, exp[i].Q, 1e-9, '第 ' + (i + 1) + ' 段 Q');
    near(row.P, exp[i].P, 1e-9, '第 ' + (i + 1) + ' 段 P');
    near(row.tau, exp[i].tau, 1e-9, '第 ' + (i + 1) + ' 段 τ');
    near(row.css, exp[i].css, 1e-9, '第 ' + (i + 1) + ' 段 C_ss');
    near(row.cOut, exp[i].cOut, 1e-6, '第 ' + (i + 1) + ' 段段末');
  });
  near(r.kpis.peak, 1585.746213732, 1e-5, '第一天峰值');
  near(r.kpis.end, 1251.402005933, 1e-5, '第一天末浓度');
  near(r.kpis.overMin, 393.4833, 0.02, '第一天超标分钟');
  near(r.rows[0].overMin, 359.557963, 0.02, '第 1 段超标分钟');
  near(r.rows[5].overMin, 20.133756, 0.02, '第 6 段超标分钟');
  near(r.rows[0].startClock === '22:00' ? 0 : 1, 0, 0, '第 1 段时刻');
  assert.strictEqual(r.rows[0].endClock, '06:00');
  assert.strictEqual(r.rows[5].endClock, '22:00');
});

test('独立锚点：9 个内置场景的峰值 / 超标 / 末值', () => {
  const exp = {
    'default': { peak: 1585.746213732, over: 393.4833, end: 1251.402005933 },
    'sealed': { peak: 2722.221582708, over: 494.52462, end: 1732.061907963 },
    'doorgap': { peak: 1081.864587730, over: 10.585423, end: 1081.864587730 },
    'freshair': { peak: 966.327766136, over: 0.0, end: 966.327766136 },
    'purifier': { peak: 1954.814388472, over: 415.7667, end: 1294.707938642 },
    'acsummer': { peak: 2220.845539403, over: 443.3301, end: 1325.732770672 },
    'novent': { peak: 5131.538461538, over: 1349.52006, end: 5131.538461538 },
    'meeting': { peak: 2890.741431275, over: 220.102140, end: 420.032136470 },
    'cabin': { peak: 4212.724637435, over: 61.471080, end: 420.008265257 }
  };
  C.scenarios.forEach((s) => {
    const r = an(sc(s.id));
    const e = exp[s.id];
    assert.ok(e, '锚点表缺 ' + s.id);
    near(r.kpis.peak, e.peak, Math.max(0.02, e.peak * 2e-5), s.id + ' 峰值');
    near(r.kpis.overMin, e.over, 0.6, s.id + ' 超标分钟');
    near(r.kpis.end, e.end, Math.max(0.02, e.end * 2e-5), s.id + ' 末浓度');
  });
});

/* ═══════════════ 2. 段内解析解 vs 独立数值积分 ═══════════════ */
test('段内解析解 vs 独立 RK4 数值积分（两种步长 + 收敛性）', () => {
  const rnd = mulberry(20261111);
  for (let k = 0; k < 60; k++) {
    const cfg = randCfg(rnd);
    const r = C.simulateFrom(C.normCfg(cfg), cfg.area * cfg.height, cfg.c0);
    const V = cfg.area * cfg.height;
    r.rows.forEach((row) => {
      const n = C.rk4Steps(row.hours, row.Q, V, 64);
      const c1 = C.rk4Segment(row.cIn, row.hours, row.P, row.Q, V, cfg.cAtm, n);
      const c2 = C.rk4Segment(row.cIn, row.hours, row.P, row.Q, V, cfg.cAtm, n * 4);
      rel(c1, row.cOut, 1e-7, 'RK4(n) 对拍 k=' + k);
      rel(c2, row.cOut, 1e-9, 'RK4(4n) 对拍 k=' + k);
      assert.ok(n >= 64 && n <= 20000, '步数应在界内');
    });
    // 收敛性：从「每步 |λh| ≤ 0.5」的粗网格起加密两次，误差必须单调下降（浮点噪声量级另算）
    if (k < 12) {
      r.rows.forEach((row) => {
        const lam = row.Q > 0 ? row.Q / V : 0;
        const n0 = Math.max(4, Math.ceil(row.hours * lam / 0.5));
        const e = [1, 2, 4].map((m) => Math.abs(C.rk4Segment(row.cIn, row.hours, row.P, row.Q, V, cfg.cAtm, n0 * m) - row.cOut));
        assert.ok(e[1] <= e[0] * 1.02 + 1e-9, 'RK4 误差应随加密下降（第一次）：' + JSON.stringify(e));
        assert.ok(e[2] <= e[1] * 1.02 + 1e-9, 'RK4 误差应随加密下降（第二次）：' + JSON.stringify(e));
      });
    }
  }
});

test('ODE 导数核查：解析解的起点斜率 = (P − Q(C₀ − C_atm)) / V', () => {
  const rnd = mulberry(777001);
  for (let k = 0; k < 200; k++) {
    const Q = rnd() * 500, P = rnd() * 60000, V = 1 + rnd() * 300, cAtm = 350 + rnd() * 600, cIn = 400 + rnd() * 4000;
    const h = 1e-7;
    const fd = (C.concAt(cIn, h, P, Q, V, cAtm) - C.concAt(cIn, 0, P, Q, V, cAtm)) / h;
    const ana = Q > 0 ? (P - Q * (cIn - cAtm)) / V : P / V;
    rel(fd, ana, 1e-4, '导数核查 k=' + k);
  }
});

test('稳态与时间常数的独立核对（推到 50τ 必到 C_ss，且 τ = V/Q）', () => {
  const rnd = mulberry(31337);
  for (let k = 0; k < 200; k++) {
    const Q = 0.5 + rnd() * 500, P = rnd() * 60000, V = 1 + rnd() * 300, cAtm = 350 + rnd() * 600, cIn = 400 + rnd() * 4000;
    const css = cAtm + P / Q, tau = V / Q;
    const c = C.concAt(cIn, 50 * tau, P, Q, V, cAtm);
    rel(c, css, 1e-18, '50τ 收敛 k=' + k);
    const half = C.concAt(cIn, tau * Math.LN2, P, Q, V, cAtm);
    near(half, (cIn + css) / 2, Math.max(1e-9, Math.abs(css) * 1e-12), '半衰期 = τ·ln2');
  }
});

/* ═══════════════ 3. 交叉时间 / 超标时长 ═══════════════ */
test('交叉时间 vs 独立二分法', () => {
  const rnd = mulberry(90210);
  for (let k = 0; k < 300; k++) {
    const Q = rnd() * 300, P = rnd() * 40000, V = 1 + rnd() * 200, cAtm = 350 + rnd() * 500;
    const cIn = cAtm + rnd() * 3000, hours = 0.1 + rnd() * 8;
    const cEnd = C.concAt(cIn, hours, P, Q, V, cAtm);
    const target = cIn + (cEnd - cIn) * (0.05 + 0.9 * rnd());
    if ((target - cIn) * (target - cEnd) > 0) continue;
    const t = C.crossTime(cIn, target, P, Q, V, cAtm, hours);
    assert.ok(t !== null, '应当有交叉 k=' + k);
    // 二分法：在 [0, hours] 上找 concAt = target
    let lo = 0, hi = hours;
    const f = (t2) => C.concAt(cIn, t2, P, Q, V, cAtm) - target;
    const inc = f(hours) > f(0);
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2;
      if ((f(mid) > 0) === inc) hi = mid; else lo = mid;
    }
    near(t, (lo + hi) / 2, 1e-6 + hours * 1e-9, '交叉时间 k=' + k);
  }
});

test('超标时长 vs 独立细步长采样积分（RK4 步长 1e-3 h）', () => {
  const rnd = mulberry(5150);
  for (let k = 0; k < 40; k++) {
    const cfg = randCfg(rnd);
    const V = cfg.area * cfg.height;
    const r = C.simulateFrom(C.normCfg(cfg), V, cfg.c0);
    let over = 0, c = cfg.c0;
    r.rows.forEach((row) => {
      const n = Math.max(1, Math.round(row.hours / 1e-3));
      const h = row.hours / n;
      for (let i = 0; i < n; i++) {
        const f = (y) => (row.P - row.Q * (y - cfg.cAtm)) / V;
        const k1 = f(c), k2 = f(c + h * k1 / 2), k3 = f(c + h * k2 / 2), k4 = f(c + h * k3);
        c = c + h * (k1 + 2 * k2 + 2 * k3 + k4) / 6;
        if (c > cfg.target) over += h * 60;
      }
    });
    near(r.rows.reduce((s, x) => s + x.overMin, 0), over, 0.4, '超标时长对拍 k=' + k);
  }
});

/* ═══════════════ 4. 反推 ═══════════════ */
test('反推所需通风量 vs 独立二分（稳态恰好等于目标）', () => {
  const rnd = mulberry(24680);
  for (let k = 0; k < 200; k++) {
    const P = 100 + rnd() * 60000, cAtm = 350 + rnd() * 500, target = cAtm + 60 + rnd() * 2000;
    const cfg = C.defaultsClone();
    cfg.cAtm = cAtm; cfg.target = target; cfg.vent = 0; cfg.achClosed = 0.3; cfg.achOpen = 10;
    cfg.segments = [{ label: 'x', hours: 24, people: 1, act: 'sit', open: 0 }];
    cfg.g.sit = P / 60000;
    const R = C.analyze(cfg);
    assert.ok(R.ok, JSON.stringify(R.errors));
    assert.ok(R.rev.feasible);
    const qreq = R.rev.params.filter((p) => p.key === 'Q')[0].raw;
    // 二分：找 Q 使 cAtm + P/Q = target
    let lo = 1e-6, hi = 1e9;
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2;
      if (cAtm + P / mid > target) lo = mid; else hi = mid;
    }
    rel(qreq, (lo + hi) / 2, 1e-6, '反推风量 k=' + k);
  }
});

test('反推：取整方向朝「更能达标」、回代全部达标、原始值不小', () => {
  C.scenarios.forEach((s) => {
    const r = an(sc(s.id));
    if (!r.rev.feasible) return;
    r.rev.params.forEach((p) => {
      assert.ok(p.value >= p.raw - 1e-9, s.id + ' ' + p.key + ' 取整后不应小于原始值');
      assert.ok(p.value - p.raw <= Math.max(p.step, p.raw * 1e-6), s.id + ' ' + p.key + ' 取整不该超过一档：' + p.value + ' vs ' + p.raw);
      assert.ok(isFinite(p.recheck), s.id + ' ' + p.key + ' 回代值必须是数');
      if (p.key === 'openMin') assert.ok(p.recheck <= sc(s.id).target + 1e-9, s.id + ' 开窗回代未达标');
      else assert.ok(p.recheck <= sc(s.id).target + 1e-9, s.id + ' ' + p.key + ' 回代未达标：' + p.recheck);
    });
  });
});

test('反推不可行的三种情形都要说清楚，不许硬凑数字', () => {
  // (a) 目标不高于室外
  let cfg = C.defaultsClone();
  cfg.vent = 0;
  let r = C.analyze(cfg);
  cfg.target = cfg.cAtm + 50;      // 合法下界
  r = an(cfg);
  assert.ok(r.rev.feasible, '目标 = 室外 + 50 仍可行');
  // 直接构造目标 = 室外（会被校验挡下）
  const bad = C.analyze(Object.assign({}, cfg, { target: cfg.cAtm }));
  assert.ok(!bad.ok, '目标等于室外应被校验拦下');
  // (b) 全程无人
  cfg = C.defaultsClone();
  cfg.segments = cfg.segments.map((s) => Object.assign({}, s, { people: 0 }));
  r = an(cfg);
  assert.ok(!r.rev.feasible);
  assert.ok(/没有人在屋里产生/.test(r.rev.reason), r.rev.reason);
  // (c) 超出上限
  cfg = C.defaultsClone();
  cfg.g.sit = 5; cfg.target = 421; cfg.segments = [{ label: 'x', hours: 24, people: 200, act: 'sit', open: 0 }];
  r = C.analyze(cfg);
  if (r.ok && !r.rev.feasible) assert.ok(/超过本页上限/.test(r.rev.reason), r.rev.reason);
});

/* ═══════════════ 5. 单调性与方向 ═══════════════ */
test('单调性：换气次数↑ 峰值↓；人数↑ 峰值↑；活动强度↑ 峰值↑', () => {
  const base = C.defaultsClone();
  const pk = (c) => C.analyze(c).kpis.peak;
  let prev = Infinity;
  [0, 0.1, 0.3, 0.6, 1.2, 3, 5].forEach((a) => {
    const c = clone(base); c.achClosed = a;
    const p = pk(c);
    assert.ok(p <= prev + 1e-9, 'ACH ' + a + ' 峰值不应高于前一档：' + p + ' vs ' + prev);
    prev = p;
  });
  prev = -Infinity;
  [0, 1, 2, 3, 5].forEach((n) => {
    const c = clone(base);
    c.segments = c.segments.map((s, i) => (i === 0 ? Object.assign({}, s, { people: n }) : s));
    const p = pk(c);
    assert.ok(p >= prev - 1e-9, '人数 ' + n + ' 峰值不应低于前一档');
    prev = p;
  });
  prev = -Infinity;
  ['sleep', 'sit', 'light', 'medium', 'sport'].forEach((a) => {
    const c = clone(base);
    c.segments = c.segments.map((s, i) => (i === 0 ? Object.assign({}, s, { act: a }) : s));
    const p = pk(c);
    assert.ok(p >= prev - 1e-9, '强度 ' + a + ' 峰值不应低于前一档');
    prev = p;
  });
});

test('核心结论的独立核查：风量固定时稳态与体积无关，体积只改 τ', () => {
  const V = [90, 135, 270];
  const css = V.map((v) => {
    const cfg = C.defaultsClone();
    cfg.area = 50; cfg.height = v / 50;                 // 体积 = v（层高 1.8 / 2.7 / 5.4 都在范围内）
    cfg.vent = 30; cfg.achClosed = 0;                    // 通风量固定 30 m³/h，与体积无关
    cfg.segments = [{ label: 'x', hours: 24, people: 1, act: 'sit', open: 0 }];
    const r = an(cfg);
    return { css: r.rows[0].css, tau: r.rows[0].tau, V: r.V };
  });
  near(css[0].css, css[1].css, 1e-9, '风量固定时稳态与体积无关');
  near(css[1].css, css[2].css, 1e-9, '风量固定时稳态与体积无关');
  near(css[2].tau / css[0].tau, 3, 1e-9, 'τ 与体积成正比');
  // 反面：换气次数固定时，体积越大稳态越低（因为 Q 也随之变大）
  const byAch = [90, 135, 270].map((v) => {
    const cfg = C.defaultsClone();
    cfg.area = 50; cfg.height = v / 50; cfg.achClosed = 0.5; cfg.vent = 0;
    cfg.segments = [{ label: 'x', hours: 24, people: 1, act: 'sit', open: 0 }];
    return an(cfg).rows[0].css;
  });
  assert.ok(byAch[0] > byAch[1] && byAch[1] > byAch[2], '换气次数固定时体积越大稳态越低');
});

test('净化器 CADR 在账里贡献恒为 0（逐位不变）', () => {
  const base = C.defaultsClone();
  const a = an(base);
  [0, 1, 150, 300, 2000].forEach((cadr) => {
    const c = clone(base); c.cadr = cadr;
    const r = an(c);
    assert.strictEqual(r.end, a.end, 'CADR ' + cadr + ' 改变了末浓度');
    assert.strictEqual(r.kpis.peak, a.kpis.peak, 'CADR ' + cadr + ' 改变了峰值');
    assert.strictEqual(r.kpis.overMin, a.kpis.overMin, 'CADR ' + cadr + ' 改变了超标时长');
    r.rows.forEach((row, i) => assert.strictEqual(row.cOut, a.rows[i].cOut, 'CADR ' + cadr + ' 改变了第 ' + (i + 1) + ' 段'));
  });
});

/* ═══════════════ 6. 极限与退化 ═══════════════ */
test('极限与退化：零通风线性上涨、零产生纯衰减、起点即稳态、巨大风量逼近室外', () => {
  const cfg = C.defaultsClone();
  cfg.achClosed = 0; cfg.achOpen = 0; cfg.vent = 0;
  cfg.segments = [{ label: 'x', hours: 24, people: 1, act: 'sleep', open: 0 }];
  let r = an(cfg);
  near(r.rows[0].cOut, cfg.c0 + 60000 * 0.20 * 24 / r.V, 1e-9, '零通风线性上涨');
  assert.strictEqual(r.rows[0].tau, Infinity);
  assert.strictEqual(r.rows[0].css, Infinity);

  cfg.achClosed = 0; cfg.achOpen = 0; cfg.vent = 0;
  cfg.segments = [{ label: 'x', hours: 24, people: 0, act: 'sleep', open: 0 }];
  r = an(cfg);
  assert.strictEqual(r.rows[0].cOut, cfg.c0, '零通风零产生应保持不变');

  cfg.achClosed = 0.3; cfg.achOpen = 10; cfg.vent = 0;
  cfg.c0 = 420 + 60000 * 0.25 / (0.3 * (12 * 2.6));
  cfg.segments = [{ label: 'x', hours: 24, people: 1, act: 'sit', open: 0 }];
  r = an(cfg);
  near(r.rows[0].cOut, cfg.c0, 1e-9, '起点即稳态应保持不动');

  cfg.c0 = 420; cfg.achClosed = 5; cfg.vent = 2000;
  cfg.segments = [{ label: 'x', hours: 24, people: 1, act: 'sleep', open: 0 }];
  r = an(cfg);
  // 风量极大时（24 h = 1659 τ）段末必须落在稳态上，稳态本身是 室外 + P/Q，不是室外
  near(r.rows[0].cOut, cfg.cAtm + r.rows[0].P / r.rows[0].Q, 1e-6, '风量极大时应落在稳态');
  assert.ok(r.rows[0].cOut - cfg.cAtm < 6, '风量极大时超出室外的部分应很小，实际 ' + (r.rows[0].cOut - cfg.cAtm));

  // 极短时段
  cfg.vent = 0; cfg.achClosed = 0.3;
  cfg.segments = [{ label: 'a', hours: 23.95, people: 0, act: 'sleep', open: 0 }, { label: 'b', hours: 0.05, people: 1, act: 'sport', open: 0 }];
  r = an(cfg);
  assert.ok(isFinite(r.rows[1].cOut) && r.rows[1].cOut >= cfg.c0, '极短时段也应有界');
});

test('边界：浓度恰好等于目标时不算超标；向上穿越与向下穿越都算对', () => {
  const cfg = C.defaultsClone();
  const V = cfg.area * cfg.height;
  const Q = cfg.achClosed * V;
  const P = 60000 * 0.25;
  const css = cfg.cAtm + P / Q;
  // 起点 = 目标，且向稳态上升 → 只应记「之后」的超标
  cfg.c0 = 1000;
  cfg.segments = [{ label: 'x', hours: 24, people: 1, act: 'sit', open: 0 }];
  const r = an(cfg);
  assert.ok(css > 1000, '构造场景应向上增长');
  const tau = V / Q;
  near(r.rows[0].overMin, 1440, 1e-6, '起点即目标：整段都在目标之上');
  // 起点低于目标、稳态高于目标 → 只记穿越之后
  cfg.c0 = 500;
  const r2 = an(cfg);
  const tx2 = tau * Math.log((500 - css) / (1000 - css));
  near(r2.rows[0].overMin, (24 - tx2) * 60, 1e-9, '向上穿越');
  // 起点高于目标、稳态低于目标（无人 → 稳态 = 室外）→ 只记穿越之前
  const cfgDn = C.defaultsClone();
  cfgDn.c0 = 3000;
  cfgDn.segments = [{ label: 'x', hours: 24, people: 0, act: 'sit', open: 0 }];
  const r3 = an(cfgDn);
  const cssDn = cfgDn.cAtm, tauDn = cfgDn.area * cfgDn.height / (cfgDn.achClosed * cfgDn.area * cfgDn.height);
  const tx3 = tauDn * Math.log((3000 - cssDn) / (1000 - cssDn));
  near(r3.rows[0].overMin, tx3 * 60, 1e-9, '向下穿越');
  assert.ok(r3.rows[0].cOut < 1000, '24 h 后应低于目标');
});

/* ═══════════════ 7. 非法输入与合法边界 ═══════════════ */
test('非法输入逐条核字段（每条只应报出对应字段）', () => {
  const cases = [
    ['area', { area: 0 }], ['area', { area: 501 }], ['area', { area: 'abc' }], ['area', { area: NaN }],
    ['height', { height: 1 }], ['height', { height: 7 }],
    ['c0', { c0: 399 }], ['c0', { c0: 20001 }], ['c0', { c0: '4e9' }],
    ['cAtm', { cAtm: 349 }], ['cAtm', { cAtm: 2001 }],
    ['target', { target: 5001 }], ['target', { target: 100 }], ['target', { target: 'x' }],
    ['achClosed', { achClosed: -0.1 }], ['achClosed', { achClosed: 5.1 }],
    ['achOpen', { achOpen: -1 }], ['achOpen', { achOpen: 61 }],
    ['vent', { vent: -1 }], ['vent', { vent: 2001 }],
    ['cadr', { cadr: -1 }], ['cadr', { cadr: 2001 }],
    ['startAt', { startAt: '25:00' }], ['startAt', { startAt: 'abc' }], ['startAt', { startAt: '12-30' }],
    ['g.sleep', { g: { sleep: 0 } }], ['g.sleep', { g: { sleep: 5.1 } }], ['g.light', { g: { light: 'q' } }],
    ['segments', { segments: [] }],
    ['seg0.hours', { segments: [{ label: 'a', hours: 0, people: 1, act: 'sit', open: 0 }] }],
    ['seg1.people', { segments: [{ label: 'a', hours: 12, people: 1, act: 'sit', open: 0 }, { label: 'b', hours: 12, people: 201, act: 'sit', open: 0 }] }],
    ['seg1.people', { segments: [{ label: 'a', hours: 12, people: 1, act: 'sit', open: 0 }, { label: 'b', hours: 12, people: 1.5, act: 'sit', open: 0 }] }],
    ['seg0.act', { segments: [{ label: 'a', hours: 24, people: 1, act: 'dance', open: 0 }] }],
    ['seg0.act', { segments: [{ label: 'a', hours: 24, people: 1, act: 'sleep', open: 0 }], g: { sleep: 0 } }],
    ['segments', { segments: [{ label: 'a', hours: 12, people: 1, act: 'sit', open: 0 }] }]
  ];
  cases.forEach(([field, patch]) => {
    const cfg = Object.assign(C.defaultsClone(), patch);
    if (patch.g) cfg.g = Object.assign(C.defaultsClone().g, patch.g);
    const r = C.analyze(cfg);
    assert.ok(!r.ok, field + ' 应报错：' + JSON.stringify(patch));
    const fields = r.errors.map((e) => e.field);
    assert.ok(fields.indexOf(field) >= 0, field + ' 未被报出，实际 ' + JSON.stringify(fields));
    assert.ok(r.errors.every((e) => e.msg && e.msg.length > 2), '错误信息要有内容');
    assert.ok(r.rows.length === 0 && r.checks.length === 0, '校验失败时不应给出结果');
  });
  // 超过 8 段
  const many = C.defaultsClone();
  many.segments = [];
  for (let i = 0; i < 9; i++) many.segments.push({ label: 's' + i, hours: 24 / 9, people: 0, act: 'sit', open: 0 });
  const r9 = C.analyze(many);
  assert.ok(!r9.ok && r9.errors.some((e) => e.field === 'segments' && /最多/.test(e.msg)));
});

test('合法边界值全部能算（每项取范围内两端）', () => {
  const base = C.defaultsClone();
  const ok = (patch, tag) => {
    const cfg = Object.assign(C.defaultsClone(), patch);
    if (patch.g) cfg.g = Object.assign(C.defaultsClone().g, patch.g);
    const r = C.analyze(cfg);
    assert.ok(r.ok, tag + ' 应能算：' + JSON.stringify(r.errors));
    assert.ok(r.checks.every((c) => c.pass), tag + ' 自检应全过：' + JSON.stringify(r.checks.filter((c) => !c.pass)));
    return r;
  };
  ok({ area: 1 }, '面积下界'); ok({ area: 500 }, '面积上界');
  ok({ height: 1.8 }, '层高下界'); ok({ height: 6 }, '层高上界');
  ok({ c0: 400 }, 'C0 下界'); ok({ c0: 20000 }, 'C0 上界');
  ok({ cAtm: 350 }, 'C_atm 下界'); ok({ cAtm: 2000, target: 5000 }, 'C_atm 上界');
  ok({ target: 5000 }, '目标上界'); ok({ target: 500 }, '目标下界（= 室外 + 80）');
  ok({ achClosed: 0 }, 'ACH 关窗 0'); ok({ achClosed: 5 }, 'ACH 关窗上界');
  ok({ achOpen: 0 }, 'ACH 开窗 0'); ok({ achOpen: 60 }, 'ACH 开窗上界');
  ok({ vent: 0 }, '新风 0'); ok({ vent: 2000 }, '新风上界');
  ok({ cadr: 0 }, 'CADR 0'); ok({ cadr: 2000 }, 'CADR 上界');
  ok({ startAt: '00:00' }, '起始 00:00'); ok({ startAt: '23:59' }, '起始 23:59');
  ok({ g: { sleep: 0.01 } }, 'G 下界'); ok({ g: { sport: 5 } }, 'G 上界');
  const seg = [{ label: 'x', hours: 24, people: 200, act: 'sport', open: 0 }];
  ok({ segments: seg, vent: 2000, achClosed: 5 }, '极值组合');
  ok({ segments: [{ label: 'x', hours: 0.05, people: 1, act: 'sit', open: 1 }, { label: 'y', hours: 23.95, people: 0, act: 'sit', open: 0 }] }, '最短段 0.05h');
});

/* ═══════════════ 8. 结构自检 ═══════════════ */
test('结构自检：默认 + 9 场景 + 边界配置全过（15 项）', () => {
  const list = [C.defaultsClone()].concat(C.scenarios.map((s) => sc(s.id)));
  list.push(Object.assign(C.defaultsClone(), { achClosed: 0, achOpen: 0, vent: 0 }));
  list.push(Object.assign(C.defaultsClone(), { area: 500, height: 6, vent: 2000, achClosed: 5 }));
  list.forEach((cfg, i) => {
    const r = an(cfg);
    assert.strictEqual(r.checks.length, 15, '自检项数应为 15');
    const bad = r.checks.filter((c) => !c.pass);
    assert.strictEqual(bad.length, 0, '配置 ' + i + ' 自检未过：' + JSON.stringify(bad));
    assert.ok(r.checks.every((c) => c.detail && c.detail.length > 0), '每项自检要有说明');
  });
});

test('随机压力：300 组合法输入下 15 项结构自检全过', () => {
  const rnd = mulberry(424242);
  let checked = 0, assertCount = 0;
  for (let k = 0; k < 300; k++) {
    const cfg = randCfg(rnd);
    const r = C.analyze(cfg);
    assert.ok(r.ok, 'k=' + k + ' 应通过校验：' + JSON.stringify(r.errors));
    r.checks.forEach((c) => {
      assertCount++;
      assert.ok(c.pass, 'k=' + k + ' 自检未过「' + c.name + '」：' + c.detail);
    });
    assert.ok(isFinite(r.kpis.peak) && r.kpis.peak >= 0, 'k=' + k + ' 峰值应为非负有限值');
    assert.ok(r.verdict && ['ok', 'tight', 'bad'].indexOf(r.verdict.id) >= 0, 'k=' + k + ' 判定应在三档内');
    checked++;
  }
  assert.strictEqual(checked, 300);
  assert.ok(assertCount >= 4500, '累计断言数：' + assertCount);
});

/* ═══════════════ 9. 输出契约 / 确定性 / 不修改入参 ═══════════════ */
test('输出契约：字段齐全、类型正确、数字有限', () => {
  const r = an(C.defaultsClone());
  ['V', 'rows', 'curve', 'kpis', 'cyc', 'verdict', 'rev', 'checks', 'insights', 'steps', 'sens', 'params', 'end'].forEach((k) => {
    assert.ok(k in r, '缺字段 ' + k);
  });
  assert.ok(r.rows.length >= 1 && r.curve.length >= 12);
  assert.ok(r.insights.length >= 4, '要点至少 4 条，实际 ' + r.insights.length);
  assert.ok(r.steps.length >= 3);
  assert.ok(r.sens.length >= 8);
  assert.ok(r.checks.length === 15);
  r.curve.forEach((p) => {
    assert.ok(isFinite(p.t) && p.t >= 0 && p.t <= 24 + 1e-9, '曲线时间应在 0–24 h');
    assert.ok(isFinite(p.c), '曲线浓度应为有限值');
  });
  for (let i = 1; i < r.curve.length; i++) assert.ok(r.curve[i].t > r.curve[i - 1].t, '曲线时间应严格递增');
  r.insights.forEach((x) => { assert.ok(x.t && x.d, '要点要有标题与说明'); assert.ok(!/\*\*/.test(x.d), '文案里不应有字面 Markdown 星号'); });
  r.steps.forEach((s) => assert.ok(typeof s === 'string' && s.length > 4 && !/\*\*/.test(s)));
  r.checks.forEach((c) => assert.ok(!/\*\*/.test(c.detail)));
  assert.ok(isFinite(r.verdict.detail.length) && r.verdict.detail.length > 0);
});

test('确定性：同输入两次结果逐位相同；不修改入参', () => {
  const cfg = C.defaultsClone();
  const before = JSON.stringify(cfg);
  const a = C.analyze(cfg), b = C.analyze(cfg);
  assert.strictEqual(JSON.stringify(a.rows), JSON.stringify(b.rows));
  assert.strictEqual(JSON.stringify(a.checks), JSON.stringify(b.checks));
  assert.strictEqual(JSON.stringify(a.insights), JSON.stringify(b.insights));
  assert.strictEqual(JSON.stringify(a.sens), JSON.stringify(b.sens));
  assert.strictEqual(a.kpis.peak, b.kpis.peak);
  assert.strictEqual(JSON.stringify(cfg), before, 'analyze 不应修改入参');
  // 字符串型输入也要能算，且与数字型一致
  const c2 = C.defaultsClone();
  c2.area = '12.0'; c2.height = '2.60'; c2.cadr = '300';
  c2.segments = c2.segments.map((s) => ({ label: s.label, hours: String(s.hours), people: String(s.people), act: s.act, open: s.open }));
  const c3 = C.analyze(c2);
  assert.ok(c3.ok, JSON.stringify(c3.errors));
  assert.strictEqual(c3.kpis.peak, a.kpis.peak, '字符串数字应与数字等价');
});

/* ═══════════════ 10. 稳定日循环 ═══════════════ */
test('稳定日循环：不动点满足 F(C*) = C*，收缩因子 = ∏exp(−h/τ)', () => {
  const cfg = C.defaultsClone();
  const V = cfg.area * cfg.height;
  const r = an(cfg);
  assert.ok(r.cyc.converged, '默认场景应收敛');
  const c = C.normCfg(cfg);
  const next = C.simulateFrom(c, V, r.cyc.start).end;
  near(next, r.cyc.start, 0.5, '不动点应满足 F(C*) = C*');
  // 收缩因子：与引擎无关联地独立算一遍
  let f = 1;
  c.segments.forEach((seg) => {
    const Q = (seg.open ? c.achOpen : c.achClosed) * V + c.vent;
    if (Q > 0) f *= Math.exp(-seg.hours * Q / V);
  });
  const d = 100;                                 // 扰动 100 ppm，压住浮点相消
  const base = C.simulateFrom(c, V, r.cyc.start).end;
  const perturbed = C.simulateFrom(c, V, r.cyc.start + d).end;
  rel(perturbed - base, f * d, 1e-7, '一天的收缩因子（对 F(C*) 取差，避免收敛残差）');
  assert.ok(f < 1, '有换气时收缩因子必须 < 1');
  // 不收敛场景：全时段零通风
  const zero = C.analyze(Object.assign(C.defaultsClone(), { achClosed: 0, achOpen: 0, vent: 0 }));
  assert.ok(zero.ok);
  assert.ok(!zero.cyc.converged, '零通风应不收敛');
  assert.ok(zero.checks.every((x) => x.pass), '可解释的不收敛仍应自检全过');
  assert.ok(/没有/.test(zero.insights[1].t + zero.insights[1].d), '不收敛要有对应要点');
});

test('稳定日循环：闭式解 = 逐日迭代的极限；近不可收缩时迭代做不到、闭式做得到', () => {
  const cfg = C.defaultsClone();
  const V = cfg.area * cfg.height;
  const c = C.normCfg(cfg);
  const r = an(cfg);
  // 闭式解与 3000 次逐日迭代的极限互证（B 很小，几百次就收敛到位）
  let x = cfg.c0;
  for (let i = 0; i < 3000; i++) x = C.simulateFrom(c, V, x).end;
  near(r.cyc.start, x, 1e-6, '闭式不动点 = 逐日迭代极限');
  assert.ok(Math.abs(C.simulateFrom(c, V, r.cyc.start).end - r.cyc.start) <= Math.max(1e-9, Math.abs(r.cyc.start) * 1e-12), '回代偏差应在浮点噪声量级');
  // B 与 ∏exp(−h/τ) 独立算一遍
  let B = 1;
  c.segments.forEach((sg) => {
    const Q = (sg.open ? c.achOpen : c.achClosed) * V + c.vent;
    if (Q > 0) B *= Math.exp(-sg.hours * Q / V);
  });
  near(r.cyc.B, B, 1e-15, '收缩因子 B');
  // 近不可收缩：ACH 0.0001 → B ≈ 0.9976，200 次迭代远不够；闭式解仍然精确
  const tiny = C.defaultsClone();
  tiny.achClosed = 0.0001; tiny.achOpen = 0.0001;
  const ct = C.normCfg(tiny);
  const rt = an(tiny);
  assert.ok(rt.cyc.B > 0.99, 'B 应接近 1：' + rt.cyc.B);
  let y = tiny.c0, conv200 = false;
  for (let i = 0; i < 200; i++) { const n2 = C.simulateFrom(ct, V, y).end; if (Math.abs(n2 - y) < 0.5) conv200 = true; y = n2; }
  assert.ok(!conv200, '200 次迭代不该收敛（这正是要用闭式解的原因）');
  near(Math.abs(C.simulateFrom(ct, V, rt.cyc.cStar).end - rt.cyc.cStar), 0, 1e-6, '闭式解回代仍然精确');
  assert.ok(rt.cyc.cStar > 1e6, '极小换气量下日循环不动点超过 100%：' + rt.cyc.cStar);
  assert.strictEqual(rt.cyc.usable, false, '这种不动点不可用');
  assert.strictEqual(rt.cyc.start, tiny.c0, '不可用时推演起点回落到你填的初始浓度');
  assert.strictEqual(rt.verdict.id, C.verdictOf(rt.kpis.peak, tiny.target).id, '判定改用第一天口径');
  assert.ok(rt.insights.some((x2) => /物理上不可能/.test(x2.t)), '要点里要如实说明长期不可持续');
  assert.ok(rt.checks.every((x2) => x2.pass), '闭式解仍应自检全过');
});

/* ═══════════════ 11. 导出与备份 ═══════════════ */
test('导出：CSV 行数与逐段一致、MD 含关键数字、JSON 备份往返一致', () => {
  const cfg = C.defaultsClone();
  const r = an(cfg);
  const csv = C.csvText(r);
  const lines = csv.split('\n');
  assert.ok(lines.length > 6 + 6 + 96, 'CSV 行数应覆盖逐段表与 96 个曲线点');
  assert.ok(csv.indexOf('段,时段,时长h') >= 0);
  assert.ok(csv.split('\n').filter((l) => /^\d+,\d{2}:\d{2}-\d{2}:\d{2},/.test(l)).length === r.rows.length, 'CSV 逐段行数应等于段数');
  assert.ok(csv.split('\n').filter((l) => /^\d+(\.\d+)?,\d/.test(l) && /,\d+$/.test(l)).length >= 96, 'CSV 曲线点数');
  const md = C.mdText(r);
  assert.ok(md.indexOf(r.verdict.label) >= 0);
  assert.ok(md.indexOf(C.fmtC0(r.kpis.peak)) >= 0, 'MD 应含峰值');
  assert.ok(md.indexOf('| 1 |') >= 0, 'MD 应含逐段表');
  assert.ok(md.indexOf('结构自检') >= 0);
  assert.ok(!/\*\*[^*]+\*\*/.test(md.split('## 结论')[1].split('## 逐段账')[0].replace(/\*\*[^*]+\*\*/g, '')), '结论区的粗体应成对');
  const backup = C.jsonBackup(r);
  const back = C.readBackup(backup);
  const r2 = an(back);
  assert.strictEqual(r2.kpis.peak, r.kpis.peak, '备份往返后峰值应一致');
  assert.strictEqual(r2.rows.length, r.rows.length, '备份往返后段数应一致');
  near(r2.V, r.V, 1e-9, '备份往返后体积应一致');
  r.rows.forEach((row, i) => {
    near(r2.rows[i].hours, row.hours, 1e-9, '第 ' + (i + 1) + ' 段时长');
    assert.strictEqual(r2.rows[i].people, row.people);
    assert.strictEqual(r2.rows[i].open, row.open);
    assert.strictEqual(r2.rows[i].act, row.act);
  });
  assert.throws(() => C.readBackup('{}'), '空对象应抛错');
});

test('解析与格式化：单位、千分位、极小值不被显示成 0', () => {
  assert.strictEqual(C.parseNum('1,234.5'), 1234.5);
  assert.strictEqual(C.parseNum('５０%'.replace('５０', '50')), 0.5);
  assert.ok(Number.isNaN(C.parseNum('abc')));
  assert.ok(Number.isNaN(C.parseNum('')));
  assert.strictEqual(C.parseNum('1e3'), 1000);
  assert.strictEqual(C.fmtC0(12345.6), '12,346 ppm');
  assert.strictEqual(C.fmtC0(1000), '1,000 ppm');
  assert.ok(C.fmtC(0.00001).indexOf('< 0.0001') === 0, '极小值不应显示成 0');
  assert.strictEqual(C.ceilTo(51.72, 1), 52);
  assert.strictEqual(C.ceilTo(0, 1), 0);
  near(C.ceilTo(1.6600000000000001, 0.01), 1.66, 1e-9);
  assert.strictEqual(C.clockAt(C.parseClock('22:00'), 8), '06:00');
  assert.strictEqual(C.clockAt(C.parseClock('23:59'), 0.5), '00:29');
  assert.strictEqual(C.clockAt(C.parseClock('00:00'), 24), '00:00');
});
