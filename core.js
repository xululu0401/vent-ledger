/* 通风对账台 · 核心引擎（vent-ledger）
 *
 * 问题：关着窗睡一晚、关着窗开一上午会，屋里的 CO₂ 会涨到多少？开窗几分钟能压下来？
 *       要装多大新风才够？空气净化器到底管不管用？
 *
 * 口径（详见 需求与调研.md 第 3 节；浓度一律用 ppm，体积 m³，时间 h）：
 *   体积      V = 面积(㎡) × 净层高(m)
 *   产生项    P = 60000 × ΣG          G = 每人 CO₂ 产生率(L/min)，1 L/min = 0.06 m³/h，×1e6 → ppm·m³/h
 *   通风量    Q = (开窗 ? achOpen : achClosed) × V + vent
 *   时间常数  τ = V / Q               （Q = 0 时无稳态、线性增长）
 *   稳态      C_ss = C_atm + P / Q
 *   段内解    Q > 0 : C(t) = C_ss + (C₀ − C_ss)·exp(−t/τ)
 *             Q = 0 : C(t) = C₀ + P·t / V
 *   达标时间  t* = τ·ln((C₀ − C_ss)/(C_t − C_ss))   仅当 C_t 严格落在 C₀ 与 C_ss 之间
 *   反推风量  Q_req = P / (C_t − C_atm)              C_t ≤ C_atm 直接判「做不到」
 *   稳定日循环 把 24 h 推演当映射 F，迭代 C ← F(C) 到 |F(C) − C| < 0.5 ppm（上限 200 次）
 *
 * 判定：峰值 ≤ 目标 → 够；目标 < 峰值 ≤ 目标×1.5 → 紧；峰值 > 目标×1.5 → 不够。
 *       **1.5 倍是设计选择，不是任何标准的限值。** 判定默认按「稳定日循环」的峰值（长期每天），
 *       第一天（从你填的初始浓度出发）的峰值单独列出。
 *
 * 不做的事（见 LIMITS 与 需求与调研.md 第 3.7 节）：不建模空间不均匀、开窗风压热压、吸附与化学反应、
 * 温湿度与颗粒物；不引用也不替代任何标准条款；不联网、不查产品参数、不做健康诊断。
 */
(function (root) {
  'use strict';

  /* ── 活动强度（每人 CO₂ 产生率，L/min）——设计假设，页面上可逐项改写 ── */
  const ACTIVITIES = [
    { id: 'sleep', name: '睡眠', short: '睡眠', g: 0.20 },
    { id: 'sit', name: '静坐', short: '静坐', g: 0.25 },
    { id: 'light', name: '轻活动（站立 / 家务 / 走动）', short: '轻活动', g: 0.35 },
    { id: 'medium', name: '中等活动（快走 / 搬东西）', short: '中等', g: 0.60 },
    { id: 'sport', name: '运动', short: '运动', g: 1.50 }
  ];
  const actOf = (id) => ACTIVITIES.filter((a) => a.id === id)[0] || ACTIVITIES[1];

  /* ── 输入范围（只用来挡住明显打错的输入，不是任何标准的限值） ── */
  const AREA_MIN = 1, AREA_MAX = 500;              // ㎡
  const H_MIN = 1.8, H_MAX = 6;                    // m
  const C0_MIN = 400, C0_MAX = 20000;              // ppm
  const CATM_MIN = 350, CATM_MAX = 2000;           // ppm
  const TGT_GAP_MIN = 50, TGT_MAX = 5000;          // ppm（目标须比室外高至少 50）
  const ACHC_MIN = 0, ACHC_MAX = 5;                // 次/h
  const ACHO_MIN = 0, ACHO_MAX = 60;               // 次/h
  const VENT_MIN = 0, VENT_MAX = 2000;             // m³/h
  const CADR_MIN = 0, CADR_MAX = 2000;             // m³/h
  const G_MIN = 0.01, G_MAX = 5;                   // L/min·人
  const SEG_MAX = 8;
  const SEG_H_MIN = 0.05, SEG_H_MAX = 24;          // h
  const PEOPLE_MIN = 0, PEOPLE_MAX = 200;
  const DAY_H = 24;
  const QREQ_MAX = 20000;                          // m³/h，超过就判「做不到」
  const CONC_LIMIT = 1e6;                          // ppm（= 100%），超过就没有物理意义，直接拒绝出结果
  const CYCLE_TOL = 0.5;                           // ppm
  const CYCLE_MAX = 200;
  const GRID_MIN = 15;                             // 曲线在导出里的采样间隔（分钟）

  const VERDICT_FACTOR = 1.5;                      // 设计选择，不是标准

  /* ── 数字解析与格式化（UI 与导出共用，保证同口径） ── */
  function parseNum(v) {
    if (typeof v === 'number') return isFinite(v) ? v : NaN;
    if (v === null || v === undefined) return NaN;
    let s = String(v).trim();
    if (!s) return NaN;
    s = s.replace(/[，,\s_]/g, '').replace(/％/g, '%');
    if (s.endsWith('%')) {
      const n0 = Number(s.slice(0, -1));
      return isFinite(n0) ? n0 / 100 : NaN;
    }
    if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(s)) return NaN;
    const n = Number(s);
    return isFinite(n) ? n : NaN;
  }
  const num = (v) => { const n = parseNum(v); return isFinite(n) ? n : NaN; };

  const r2 = (x) => Math.round(x * 100) / 100;
  const r4 = (x) => Math.round(x * 10000) / 10000;
  const ceilTo = (x, step) => {
    const v = Math.ceil(x / step - 1e-9) * step;
    return v === 0 ? 0 : v;            // 避免返回 −0（显示与 JSON 都不好看）
  };

  function group3(s) {
    const parts = String(s).split('.');
    const head = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return parts.length > 1 ? head + '.' + parts[1] : head;
  }
  function fmtFix(x, d) {
    if (!isFinite(x)) return '—';
    const neg = x < 0, a = Math.abs(x);
    return (neg ? '−' : '') + group3(a.toFixed(d));
  }
  function fmtAdaptive(x, unit, maxD) {
    if (!isFinite(x)) return '—';
    const a = Math.abs(x);
    if (a === 0) return '0' + (unit ? ' ' + unit : '');
    const md = maxD === undefined ? 2 : maxD;
    if (a >= 1) return fmtFix(x, md) + (unit ? ' ' + unit : '');
    if (a >= 0.01) return fmtFix(x, 2) + (unit ? ' ' + unit : '');
    if (a >= 1e-4) return fmtFix(x, 4) + (unit ? ' ' + unit : '');
    return (x < 0 ? '−' : '') + '< 0.0001' + (unit ? ' ' + unit : '');
  }
  const fmtC = (x) => fmtAdaptive(x, 'ppm', 1);
  const fmtC0 = (x) => (isFinite(x) ? fmtFix(x, 0) + ' ppm' : '—');
  const fmtVol = (x) => fmtAdaptive(x, 'm³', 2);
  const fmtQ = (x) => fmtAdaptive(x, 'm³/h', 2);
  const fmtACH = (x) => fmtAdaptive(x, '次/h', 2);
  const fmtHrs = (x) => (isFinite(x) ? fmtFix(x, 2) + ' h' : '—');
  const fmtMin = (x) => (isFinite(x) ? fmtFix(x, 0) + ' 分钟' : '—');
  const fmtPct = (x, d) => (isFinite(x) ? fmtFix(x, d === undefined ? 1 : d) + '%' : '—');
  const fmtRatio = (x) => (isFinite(x) ? fmtFix(x, 2) + '×' : '—');
  const fmtG = (x) => fmtAdaptive(x, 'L/min', 2);

  /* ── 配置规范化 ─────────────────────────────────── */
  function defaults() {
    return {
      area: 12.0, height: 2.60,
      c0: 420, cAtm: 420, target: 1000,
      achClosed: 0.30, achOpen: 10, vent: 0, cadr: 0,
      startAt: '22:00',
      g: { sleep: 0.20, sit: 0.25, light: 0.35, medium: 0.60, sport: 1.50 },
      segments: [
        { label: '睡觉', hours: 8.00, people: 1, act: 'sleep', open: 0 },
        { label: '开窗通风', hours: 0.25, people: 0, act: 'sit', open: 1 },
        { label: '起床洗漱', hours: 1.00, people: 1, act: 'light', open: 0 },
        { label: '开窗通风', hours: 0.25, people: 0, act: 'sit', open: 1 },
        { label: '白天无人', hours: 13.50, people: 0, act: 'sit', open: 0 },
        { label: '晚上两人', hours: 1.00, people: 2, act: 'sit', open: 0 }
      ]
    };
  }
  function defaultsClone() {
    const d = defaults();
    d.g = Object.assign({}, d.g);
    d.segments = d.segments.map((s) => Object.assign({}, s));
    return d;
  }
  const NUMFIELDS = ['area', 'height', 'c0', 'cAtm', 'target', 'achClosed', 'achOpen', 'vent', 'cadr'];
  const SEGFIELDS = ['hours', 'people'];

  function normCfg(cfg) {
    const d = defaults();
    const c = {};
    const src = cfg || {};
    NUMFIELDS.forEach((k) => { c[k] = (src[k] === undefined || src[k] === null || src[k] === '') ? d[k] : num(src[k]); });
    c.startAt = (src.startAt === undefined || src.startAt === null || src.startAt === '') ? d.startAt : String(src.startAt).trim();
    const g = Object.assign({}, d.g);
    if (src.g && typeof src.g === 'object') {
      Object.keys(g).forEach((k) => {
        if (src.g[k] !== undefined && src.g[k] !== null && src.g[k] !== '') {
          const v = num(src.g[k]);
          g[k] = isFinite(v) ? v : NaN;
        }
      });
    }
    c.g = g;
    const segs = Array.isArray(src.segments) ? src.segments : d.segments;
    c.segments = segs.map((s, i) => {
      const o = {};
      o.label = (s && s.label !== undefined && s.label !== null) ? String(s.label).trim() : '';
      SEGFIELDS.forEach((k) => { o[k] = (s && s[k] !== undefined && s[k] !== null && s[k] !== '') ? num(s[k]) : NaN; });
      o.act = (s && s.act) ? String(s.act) : 'sit';
      o.open = !!(s && (s.open === true || s.open === 1 || s.open === '1' || s.open === 'open' || s.open === '开窗'));
      if (!o.label) o.label = defaultSegLabel(o, i);
      return o;
    });
    return c;
  }
  function defaultSegLabel(seg, i) {
    const n = i + 1;
    if (seg.people === 0) return '第 ' + n + ' 段（无人）';
    return '第 ' + n + ' 段（' + seg.people + ' 人 · ' + actOf(seg.act).short + '）';
  }

  /* ── 校验 ───────────────────────────────────────── */
  function parseClock(s) {
    const m = /^(\d{1,2}):(\d{1,2})$/.exec(String(s || '').trim());
    if (!m) return NaN;
    const h = Number(m[1]), mi = Number(m[2]);
    if (!(h >= 0 && h <= 23 && mi >= 0 && mi <= 59)) return NaN;
    return h * 60 + mi;
  }
  function clockAt(startMin, hours) {
    const t = startMin + hours * 60;
    let m = Math.round(t) % (24 * 60);
    if (m < 0) m += 24 * 60;
    const h = Math.floor(m / 60), mi = m % 60;
    return (h < 10 ? '0' : '') + h + ':' + (mi < 10 ? '0' : '') + mi;
  }

  function validate(c) {
    const e = [];
    const push = (field, msg) => e.push({ field: field, msg: msg });
    const rng = (k, min, max, name, unit) => {
      const v = c[k];
      if (!isFinite(v)) { push(k, name + '必须是数字'); return false; }
      if (v < min || v > max) { push(k, name + '应在 ' + min + '–' + max + ' ' + unit + ' 之间，当前 ' + v); return false; }
      return true;
    };
    rng('area', AREA_MIN, AREA_MAX, '房间面积', '㎡');
    rng('height', H_MIN, H_MAX, '净层高', 'm');
    rng('c0', C0_MIN, C0_MAX, '初始 CO₂ 浓度', 'ppm');
    rng('cAtm', CATM_MIN, CATM_MAX, '室外 / 新风 CO₂ 浓度', 'ppm');
    rng('achClosed', ACHC_MIN, ACHC_MAX, '关窗换气次数', '次/h');
    rng('achOpen', ACHO_MIN, ACHO_MAX, '开窗换气次数', '次/h');
    rng('vent', VENT_MIN, VENT_MAX, '机械新风量', 'm³/h');
    rng('cadr', CADR_MIN, CADR_MAX, '净化器 CADR', 'm³/h');
    if (isFinite(c.target)) {
      if (c.target < CATM_MIN || c.target > TGT_MAX) push('target', '目标浓度应在 ' + CATM_MIN + '–' + TGT_MAX + ' ppm 之间，当前 ' + c.target);
      else if (isFinite(c.cAtm) && c.target < c.cAtm + TGT_GAP_MIN) push('target', '目标浓度要比室外浓度高至少 ' + TGT_GAP_MIN + ' ppm（现在目标 ' + c.target + ' ppm、室外 ' + c.cAtm + ' ppm），否则换气不可能达标');
    } else push('target', '目标浓度必须是数字');
    if (!isFinite(parseClock(c.startAt))) push('startAt', '起始时刻要写成 HH:MM（00:00–23:59），当前「' + c.startAt + '」');
    Object.keys(c.g || {}).forEach((k) => {
      const v = c.g[k];
      if (!isFinite(v)) push('g.' + k, actOf(k).name + ' 的每人产生率必须是数字');
      else if (v < G_MIN || v > G_MAX) push('g.' + k, actOf(k).name + ' 的每人产生率应在 ' + G_MIN + '–' + G_MAX + ' L/min 之间，当前 ' + v);
    });
    if (!Array.isArray(c.segments) || !c.segments.length) push('segments', '至少要有一个时段');
    else if (c.segments.length > SEG_MAX) push('segments', '时段最多 ' + SEG_MAX + ' 段');
    else {
      let total = 0;
      c.segments.forEach((s, i) => {
        const tag = '第 ' + (i + 1) + ' 段';
        if (!isFinite(s.hours)) push('seg' + i + '.hours', tag + '的时长必须是数字');
        else if (s.hours < SEG_H_MIN || s.hours > SEG_H_MAX) push('seg' + i + '.hours', tag + '的时长应在 ' + SEG_H_MIN + '–' + SEG_H_MAX + ' h 之间，当前 ' + s.hours);
        else total += s.hours;
        if (!isFinite(s.people)) push('seg' + i + '.people', tag + '的人数必须是数字');
        else if (s.people < PEOPLE_MIN || s.people > PEOPLE_MAX) push('seg' + i + '.people', tag + '的人数应在 ' + PEOPLE_MIN + '–' + PEOPLE_MAX + ' 之间，当前 ' + s.people);
        else if (Math.abs(s.people - Math.round(s.people)) > 1e-9) push('seg' + i + '.people', tag + '的人数必须是整数');
        if (!ACTIVITIES.some((a) => a.id === s.act)) push('seg' + i + '.act', tag + '的活动强度「' + s.act + '」不认识');
        if (s.people > 0 && isFinite(c.g[s.act]) && c.g[s.act] <= 0) push('seg' + i + '.act', tag + '有人但产生率为 0，请填一个正数');
      });
      if (isFinite(total) && Math.abs(total - DAY_H) > 1e-6) {
        push('segments', '时段合计 ' + fmtFix(total, 2) + ' h，需要正好 ' + DAY_H + '.00 h（' +
          (total < DAY_H ? '还差 ' : '多了 ') + fmtFix(Math.abs(DAY_H - total), 2) + ' h）');
      }
    }
    return e;
  }

  /* ── 几何与物理量 ───────────────────────────────── */
  const personG = (c, act) => (isFinite(c.g[act]) ? c.g[act] : actOf(act).g);
  const segSumG = (c, seg) => seg.people * personG(c, seg.act);              // L/min
  const segP = (c, seg) => 60000 * segSumG(c, seg);                          // ppm·m³/h
  const segQ = (c, seg, V) => (seg.open ? c.achOpen : c.achClosed) * V + c.vent;  // m³/h
  const segAch = (c, seg) => (seg.open ? c.achOpen : c.achClosed);
  const ventName = (seg) => (seg.open ? '开窗' : '关窗');

  /* 段内解析解 */
  function concAt(cIn, t, P, Q, V, cAtm) {
    if (Q > 0) {
      const css = cAtm + P / Q, tau = V / Q;
      return css + (cIn - css) * Math.exp(-t / tau);
    }
    return cIn + P * t / V;
  }
  /* 段内从 cIn 出发到达 target 所需时间；不经过则返回 null */
  function crossTime(cIn, target, P, Q, V, cAtm, hours) {
    if (Q > 0) {
      const css = cAtm + P / Q, tau = V / Q;
      const a = cIn - css, b = target - css;
      if (!(a !== 0 && b !== 0 && a / b > 0)) return null;
      const t = tau * Math.log(a / b);
      if (!isFinite(t) || t < 0 || t > hours) return null;
      return t;
    }
    if (!(P > 0)) return null;
    const t = (target - cIn) * V / P;
    if (!isFinite(t) || t < 0 || t > hours) return null;
    return t;
  }
  /* 段内高于 target 的分钟数（段内浓度单调，所以只有 0 / 整段 / 交叉三种情形） */
  function overMinutes(cIn, cOut, target, P, Q, V, cAtm, hours) {
    const total = hours * 60;
    const aOver = cIn > target, bOver = cOut > target;
    if (aOver && bOver) return total;
    if (!aOver && !bOver) return 0;
    const t = crossTime(cIn, target, P, Q, V, cAtm, hours);
    if (t === null) return aOver ? total : 0;
    return aOver ? t * 60 : (hours - t) * 60;
  }

  /* ── 单次 24 小时推演 ───────────────────────────── */
  function simulateFrom(c, V, c0) {
    const startMin = parseClock(c.startAt);
    const rows = [];
    let cur = c0, tAbs = 0;
    const curve = [{ t: 0, c: c0, i: -1 }];
    c.segments.forEach((seg, i) => {
      const P = segP(c, seg), Q = segQ(c, seg, V);
      const tau = Q > 0 ? V / Q : Infinity;
      const css = Q > 0 ? c.cAtm + P / Q : (P > 0 ? Infinity : cur);
      const cIn = cur;
      const cOut = concAt(cIn, seg.hours, P, Q, V, c.cAtm);
      const step = Math.max(0.05, seg.hours);
      const N = Math.min(160, Math.max(12, Math.ceil(seg.hours * 20)));
      for (let k = 1; k <= N; k++) {
        const t = seg.hours * k / N;
        curve.push({ t: tAbs + t, c: concAt(cIn, t, P, Q, V, c.cAtm), i: i });
      }
      rows.push({
        i: i, label: seg.label, seg: seg,
        startClock: clockAt(startMin, tAbs), endClock: clockAt(startMin, tAbs + seg.hours),
        hours: seg.hours, people: seg.people, act: seg.act, actName: actOf(seg.act).name, actShort: actOf(seg.act).short,
        g: personG(c, seg.act), sumG: segSumG(c, seg), P: P,
        open: seg.open, ventName: ventName(seg), ach: segAch(c, seg), Q: Q,
        tau: tau, css: css, cIn: cIn, cOut: cOut,
        overMin: overMinutes(cIn, cOut, c.target, P, Q, V, c.cAtm, seg.hours),
        rise: cOut - cIn
      });
      cur = cOut; tAbs += seg.hours;
    });
    return { rows: rows, curve: curve, end: cur, totalHours: tAbs };
  }

  function kpisOf(c, rows, curve, c0, end) {
    let peak = c0, peakAt = 0, min = c0, minAt = 0;
    curve.forEach((p) => {
      if (p.c > peak) { peak = p.c; peakAt = p.t; }
      if (p.c < min) { min = p.c; minAt = p.t; }
    });
    rows.forEach((r) => {
      if (r.cIn > peak) { peak = r.cIn; peakAt = 0; }
      if (r.cOut > peak) { peak = r.cOut; peakAt = r.i; }
      if (r.cIn < min) { min = r.cIn; minAt = r.i; }
      if (r.cOut < min) { min = r.cOut; minAt = r.i; }
    });
    const overMin = rows.reduce((s, r) => s + r.overMin, 0);
    const worst = rows.slice().sort((a, b) => b.cOut - a.cOut)[0];
    return {
      c0: c0, end: end, gap: end - c0,
      peak: peak, peakAt: peakAt, min: min, minAt: minAt,
      overMin: overMin, overHours: overMin / 60,
      totalHours: rows.reduce((s, r) => s + r.hours, 0),
      segN: rows.length,
      worstLabel: worst ? worst.label : '',
      personHours: rows.reduce((s, r) => s + r.people * r.hours, 0),
      maxP: rows.reduce((m, r) => Math.max(m, r.P), 0)
    };
  }

  function verdictOf(peak, target) {
    if (!isFinite(peak) || !isFinite(target)) return { id: 'na', label: '算不出', detail: '' };
    if (peak <= target) return { id: 'ok', label: '够', detail: '峰值 ' + fmtC0(peak) + ' 不超过目标 ' + fmtC0(target) };
    if (peak <= target * VERDICT_FACTOR) return { id: 'tight', label: '紧', detail: '峰值 ' + fmtC0(peak) + ' 超过目标 ' + fmtC0(target) + '，但没有超过目标 ×' + VERDICT_FACTOR };
    return { id: 'bad', label: '不够', detail: '峰值 ' + fmtC0(peak) + ' 超过目标 ×' + VERDICT_FACTOR + '（' + fmtC0(target * VERDICT_FACTOR) + '）' };
  }

  /* ── 稳定日循环（映射 F 的不动点） ────────────────── */
  /* 一天下来，初始浓度被乘上的系数：∏ exp(−h/τ)（Q = 0 的段贡献 1） */
  function decayFactorOf(c, V) {
    let f = 1;
    c.segments.forEach((seg) => {
      const Q = segQ(c, seg, V);
      if (Q > 0) f *= Math.exp(-seg.hours / (V / Q));
    });
    return f;
  }
  function cycleOf(c, V, c0) {
    /* 把「跑一天」看成仿射映射 F(C) = A + B·C：
     *   B = ∏ exp(−时长/τ)（Q = 0 的段贡献 1）
     *   A = F(0)
     * 于是不动点可以闭式解出来 C* = A / (1 − B)，不需要迭代到收敛——
     * 换气量极小时 B 会非常接近 1（例如 0.997），逐日迭代要几千天才收敛，
     * 闭式解一步给出，并且可以立刻回代 F(C*) 验证。 */
    const B = decayFactorOf(c, V);
    const A = simulateFrom(c, V, 0).end;
    let start = c0, converged = false, reason = '';
    if (B < 1 - 1e-15) {
      start = A / (1 - B);
      converged = true;
    } else if (Math.abs(A) <= 1e-9) {
      start = c0; converged = true;
      reason = '全天没有换气、也没有人产生 CO₂：浓度本来就不变，任何起点都是日循环。';
    } else {
      start = c0; converged = false;
      reason = '所有时段的通风量都是 0：每天净增 ' + fmtC0(A) + '，不存在日循环。';
    }
    const cStar = start;
    const usable = converged && isFinite(cStar) && cStar < CONC_LIMIT;
    const start0 = usable ? cStar : c0;
    const sim = simulateFrom(c, V, start0);
    const kp = kpisOf(c, sim.rows, sim.curve, start0, sim.end);
    const d0 = Math.abs(c0 - cStar);
    let days = 0;
    if (usable && B < 1 && d0 > CYCLE_TOL && B > 0) {
      days = Math.ceil(Math.log(CYCLE_TOL / d0) / Math.log(B));
      if (!isFinite(days) || days < 0) days = 0;
    }
    return {
      converged: converged, usable: usable, reason: reason, cStar: cStar,
      B: B, A: A, days: days, iters: days,
      start: start0, end: sim.end, gap: sim.end - start0,
      sim: sim, rows: sim.rows, curve: sim.curve, peak: kp.peak, overMin: kp.overMin,
      trace: [c0, sim.end]
    };
  }

  /* ── 反推：要压到目标浓度需要什么 ─────────────────── */
  function reverseSolve(c, V, rows, peak, target) {
    const out = { feasible: false, reason: '', params: [], notes: [], worst: null, target: target };
    if (!(target > c.cAtm + 1e-9)) {
      out.reason = '目标浓度 ' + fmtC0(target) + ' 不高于室外 / 新风浓度 ' + fmtC0(c.cAtm) +
        '，换气不可能把浓度压到目标以下。要么把目标调高，要么换更低浓度的新风源。';
      return out;
    }
    const worst = rows.slice().sort((a, b) => (b.P - a.P) || (b.cOut - a.cOut))[0];
    if (!worst || !(worst.P > 0)) {
      out.reason = '所有时段都没有人在屋里产生 CO₂，这本账里没有需要通风抵消的产生项。';
      return out;
    }
    out.worst = worst;
    const Qreq = worst.P / (target - c.cAtm);
    if (Qreq > QREQ_MAX) {
      out.reason = '按「' + worst.label + '」的产生率与目标 ' + fmtC0(target) + '，需要 ' + fmtQ(Qreq) +
        ' 的总通风量，超过本页上限 ' + fmtQ(QREQ_MAX) + '——这个目标在单间换气下不现实。';
      return out;
    }
    const n = Math.max(1, worst.people);
    // 1) 需要总通风量
    const qR = ceilTo(Qreq, 1);
    // 2) 对应换气次数（机械新风先算进去）
    const achNeed = Math.max(0, (Qreq - c.vent) / V);
    const achR = ceilTo(achNeed, 0.01);
    // 3) 每人需要的新风
    const perNeed = Qreq / n;
    const perR = ceilTo(perNeed, 1);
    // 4) 机械新风还差多少
    const ventNeed = Math.max(0, Qreq - c.vent);
    const ventR = ceilTo(ventNeed, 5);
    // 5) 开窗时长（把全天的峰值压到目标）
    const Qopen = c.achOpen * V + c.vent;
    let openMin = null, openRecheckC = null, openRaw = null;
    const notes = [];
    if (Qopen > 0 && peak > target) {
      const tauO = V / Qopen;
      openRaw = tauO * Math.log((peak - c.cAtm) / (target - c.cAtm)) * 60;
      if (isFinite(openRaw) && openRaw > 0) {
        openMin = Math.ceil(openRaw - 1e-9);
        openRecheckC = concAt(peak, openMin / 60, 0, Qopen, V, c.cAtm);
      }
    } else if (peak <= target) {
      openMin = 0; openRecheckC = peak; openRaw = 0;
    } else if (Qopen <= 0) {
      notes.push('开窗换气次数填的是 ' + fmtACH(c.achOpen) + '、机械新风 ' + fmtQ(c.vent) +
        '，没有可用的开窗通风量——本页算不出「开窗多久」，要么把开窗换气次数改成大于 0 的值，要么别指望开窗。');
    }
    const params = [
      {
        key: 'Q', label: '需要总通风量', value: qR, unit: 'm³/h', step: 1, raw: Qreq,
        note: '按产生最多的「' + worst.label + '」（' + worst.people + ' 人 · ' + worst.actShort + '）算：' +
          fmtC0(worst.P) + ' ÷（' + fmtC0(target) + ' − ' + fmtC0(c.cAtm) + '）',
        recheck: c.cAtm + worst.P / qR, recheckOk: (c.cAtm + worst.P / qR) <= target + 1e-9
      },
      {
        key: 'ach', label: '对应换气次数', value: achR, unit: '次/h', step: 0.01, raw: achNeed,
        note: '机械新风 ' + fmtQ(c.vent) + ' 先算进去，剩下的靠换气；房间体积 ' + fmtVol(V),
        recheck: c.cAtm + worst.P / (achR * V + c.vent), recheckOk: (c.cAtm + worst.P / (achR * V + c.vent)) <= target + 1e-9
      },
      {
        key: 'per', label: '每人需要新风', value: perR, unit: 'm³/h·人', step: 1, raw: perNeed,
        note: worst.people + ' 个人分摊；稳态只取决于「产生率 ÷ 风量」，与房间多大无关',
        recheck: c.cAtm + worst.P / (perR * n), recheckOk: (c.cAtm + worst.P / (perR * n)) <= target + 1e-9
      },
      {
        key: 'vent', label: '机械新风还差', value: ventR, unit: 'm³/h', step: 5, raw: ventNeed,
        note: '你已填 ' + fmtQ(c.vent) + '；再补这么多就能把「' + worst.label + '」的稳态压到目标',
        recheck: c.cAtm + worst.P / (c.vent + ventR), recheckOk: (c.cAtm + worst.P / (c.vent + ventR)) <= target + 1e-9
      }
    ];
    if (openMin !== null) {
      params.push({
        key: 'openMin', label: '开窗压峰值', value: openMin, unit: '分钟', step: 1, raw: openRaw,
        note: '从全天峰值 ' + fmtC0(peak) + ' 用开窗（' + fmtACH(c.achOpen) + '）压到目标 ' + fmtC0(target),
        recheck: openRecheckC, recheckOk: openRecheckC !== null && openRecheckC <= target + 1e-9
      });
    }
    out.feasible = true;
    out.params = params;
    out.notes = notes;
    out.Qreq = Qreq;
    return out;
  }

  /* ── 敏感性：每一行完整重算 ──────────────────────── */
  function sensitivity(c, V, base) {
    const rows = [];
    /* 产生率最大的那一段（「最闷的一段」与「最重的时段」是同一段） */
    const busiest = c.segments.map((s, i) => ({ s: s, i: i })).sort((a, b) => (b.s.people * personG(c, b.s.act)) - (a.s.people * personG(c, a.s.act)))[0];
    const run = (label, patch, note) => {
      const c2 = Object.assign({}, c, patch);
      if (patch.segments) c2.segments = patch.segments;
      const V2 = patch.area !== undefined || patch.height !== undefined
        ? (patch.area !== undefined ? patch.area : c.area) * (patch.height !== undefined ? patch.height : c.height)
        : V;
      const sim = simulateFrom(c2, V2, c.c0);
      const kp = kpisOf(c2, sim.rows, sim.curve, c.c0, sim.end);
      const cyc = cycleOf(c2, V2, c.c0);
      const pv = cyc.converged ? verdictOf(cyc.peak, c2.target) : verdictOf(kp.peak, c2.target);
      rows.push({
        label: label, peak: kp.peak, overMin: kp.overMin, end: sim.end,
        cycPeak: cyc.peak, cycOver: kpisOf(c2, cyc.rows, cyc.curve, cyc.start, cyc.end).overMin,
        verdict: pv, delta: kp.peak - base.peak, note: note || ''
      });
    };
    rows.push({
      label: '当前设置', peak: base.peak, overMin: base.overMin, end: base.end,
      cycPeak: base.cycPeak, cycOver: base.cycOver, verdict: base.verdict, delta: 0, note: '判定基准'
    });
    run('关窗换气次数 ×1.5', { achClosed: Math.min(ACHC_MAX, c.achClosed * 1.5) }, '门窗更漏风一点');
    run('关窗换气次数 ×0.5', { achClosed: c.achClosed * 0.5 }, '门窗更密封一点');
    run('关窗换气次数 = 0.80', { achClosed: 0.80 }, '常见「留一条门缝」的量级（设计假设）');
    run('房间面积 +20%', { area: Math.min(AREA_MAX, c.area * 1.2) }, '体积变大，τ 变长');
    /* 用「第一天段末浓度最高的那一段」当最闷的一段——和页面上的峰值同一口径 */
    const dayRows = simulateFrom(c, V, c.c0).rows;
    const worstSeg = dayRows.slice().sort((a, b) => b.cOut - a.cOut)[0];
    if (worstSeg) {
      const segsOpen = c.segments.map((s, i) => (i === worstSeg.i ? Object.assign({}, s, { open: 1 }) : Object.assign({}, s)));
      run('最闷的一段（' + worstSeg.label + '）改成开窗', { segments: segsOpen }, '「' + worstSeg.label + '」段末 ' + fmtC0(worstSeg.cOut) + ' → 开窗，其余不动');
    }
    run('加机械新风 30 m³/h', { vent: c.vent + 30 }, '有人时段持续送新风');
    run('加机械新风 60 m³/h', { vent: c.vent + 60 }, '');
    if (busiest) {
      const segs2 = c.segments.map((s, i) => (i === busiest.i ? Object.assign({}, s, { people: Math.min(PEOPLE_MAX, s.people + 1) }) : Object.assign({}, s)));
      run('最重的时段再多 1 人', { segments: segs2 }, '「' + busiest.s.label + '」');
      const order = ACTIVITIES.map((a) => a.id);
      const k = order.indexOf(busiest.s.act);
      const up = order[Math.min(order.length - 1, k + 1)];
      if (up && up !== busiest.s.act) {
        const segs3 = c.segments.map((s, i) => (i === busiest.i ? Object.assign({}, s, { act: up }) : Object.assign({}, s)));
        run('最重的时段活动强度上调一档', { segments: segs3 }, '「' + busiest.s.label + '」→ ' + actOf(up).short);
      }
    }
    run('净化器 CADR 从 ' + fmtFix(c.cadr, 0) + ' 改到 300', { cadr: 300 }, '对照：净化器不进这本账');
    run('目标浓度收紧到 800 ppm', { target: 800 }, '只改判定与反推的目标');
    run('目标浓度放宽到 1500 ppm', { target: 1500 }, '只改判定与反推的目标');
    return rows;
  }

  /* ── 结构自检（每次重算都跑） ────────────────────── */
  function rk4Segment(cIn, hours, P, Q, V, cAtm, steps) {
    const n = steps || 64, h = hours / n;
    const f = (y) => (P - Q * (y - cAtm)) / V;
    let c = cIn;
    for (let i = 0; i < n; i++) {
      const k1 = f(c), k2 = f(c + h * k1 / 2), k3 = f(c + h * k2 / 2), k4 = f(c + h * k3);
      c = c + h * (k1 + 2 * k2 + 2 * k3 + k4) / 6;
    }
    return c;
  }
  /* RK4 的稳定域要求 |λh| ≤ 2.785（λ = Q/V）；这里按 |λh| ≤ 1.5 取步数，避免极端输入下数值发散 */
  function rk4Steps(hours, Q, V, minSteps) {
    const base = minSteps || 64;
    if (!(Q > 0) || !(V > 0)) return base;
    return Math.min(20000, Math.max(base, Math.ceil(hours * (Q / V) / 1.5)));
  }

  function runChecks(c, V, sim, extra) {
    const rows = sim.rows, curve = sim.curve;
    const chk = [];
    const add = (name, pass, detail) => chk.push({ name: name, pass: !!pass, detail: detail });

    add('房间体积为正数', isFinite(V) && V > 0, 'V = ' + fmtVol(V));

    add('时段数与各段时长为正', rows.length >= 1 && rows.length <= SEG_MAX && rows.every((r) => isFinite(r.hours) && r.hours > 0),
      rows.length + ' 段');

    const total = rows.reduce((s, r) => s + r.hours, 0);
    add('时段合计 = 24.00 h', Math.abs(total - DAY_H) <= 1e-6, '合计 ' + fmtHrs(total));

    const concOk = rows.every((r) => isFinite(r.cIn) && isFinite(r.cOut) && r.cIn >= 0 && r.cOut >= 0);
    add('浓度有限且非负', concOk,
      '段末区间 ' + fmtC0(Math.min.apply(null, rows.map((r) => r.cOut))) + ' – ' + fmtC0(Math.max.apply(null, rows.map((r) => r.cOut))));

    let contMax = 0;
    for (let i = 1; i < rows.length; i++) contMax = Math.max(contMax, Math.abs(rows[i].cIn - rows[i - 1].cOut));
    add('段与段首尾相接', contMax <= 1e-9 * Math.max(1, Math.abs(rows[0].cIn)) + 1e-12, '最大断点 ' + contMax.toExponential(2) + ' ppm');

    let rkMax = 0, rkAt = '';
    rows.forEach((r) => {
      const n2 = rk4Segment(r.cIn, r.hours, r.P, r.Q, V, c.cAtm, rk4Steps(r.hours, r.Q, V, 64));
      const d = Math.abs(n2 - r.cOut);
      if (d > rkMax) { rkMax = d; rkAt = r.label; }
    });
    add('解析解 vs 独立 RK4 数值积分', rkMax <= 0.5, '最大差 ' + rkMax.toExponential(2) + ' ppm' + (rkAt ? '（' + rkAt + '）' : ''));

    let tauMax = 0, tauAt = '';
    rows.forEach((r) => {
      if (!isFinite(r.tau) || r.tau <= 0) return;
      const t10 = 10 * r.tau;
      const c10 = concAt(r.cIn, t10, r.P, r.Q, V, c.cAtm);
      const scale = Math.abs(r.cIn - r.css);
      const d = Math.abs(c10 - r.css);
      const bound = 1e-4 * scale + 0.01;
      if (d - bound > tauMax) { tauMax = d - bound; tauAt = r.label; }
    });
    add('τ 与 C_ss 自洽（10τ 后收敛到 C_ss）', tauMax <= 0, tauAt ? '超出容差 ' + tauMax.toExponential(2) + ' ppm（' + tauAt + '）' : '全部段在容差内');

    let cssBad = '';
    rows.forEach((r) => {
      if (r.Q > 0) {
        const css2 = c.cAtm + r.P / r.Q, tau2 = V / r.Q;
        if (Math.abs(css2 - r.css) > 1e-9 * Math.max(1, Math.abs(css2))) cssBad = r.label + '（C_ss）';
        if (Math.abs(tau2 - r.tau) > 1e-12 * Math.max(1, tau2)) cssBad = r.label + '（τ）';
      }
    });
    add('C_ss = 室外 + P/Q 与 τ = V/Q 自洽', !cssBad, cssBad || '逐段重算一致');

    const kp = kpisOf(c, rows, curve, sim.rows[0].cIn, sim.end);
    let curveMax = sim.rows[0].cIn;
    curve.forEach((p) => { if (p.c > curveMax) curveMax = p.c; });
    add('峰值 = 逐点抽样最大值', Math.abs(kp.peak - curveMax) <= 1e-6 * Math.max(1, Math.abs(kp.peak)),
      '端点法 ' + fmtC0(kp.peak) + ' / 抽样法 ' + fmtC0(curveMax));

    const overSum = rows.reduce((s, r) => s + r.overMin, 0);
    add('超标时长 = 各段之和且 ≤ 24 h', Math.abs(overSum - kp.overMin) <= 1e-9 && kp.overMin >= 0 && kp.overMin <= 1440 + 1e-6,
      fmtMin(kp.overMin) + '（' + fmtFix(kp.overMin / 1440 * 100, 1) + '% 的一天）');

    // 单调性局部自检：关窗换气次数 ×1.5 后峰值不增
    const c2 = Object.assign({}, c, { achClosed: Math.min(ACHC_MAX, c.achClosed * 1.5) });
    const sim2 = simulateFrom(c2, V, c2.c0);
    const kp2 = kpisOf(c2, sim2.rows, sim2.curve, c2.c0, sim2.end);
    add('关窗换气次数 ×1.5 后峰值不增', kp2.peak <= kp.peak + 1e-6,
      fmtC0(kp.peak) + ' → ' + fmtC0(kp2.peak));

    let gOk = true, gBad = '';
    rows.forEach((r) => {
      const s = r.people * personG(c, r.act);
      if (Math.abs(s - r.sumG) > 1e-12) { gOk = false; gBad = r.label; }
      if (Math.abs(60000 * s - r.P) > 1e-6 * Math.max(1, r.P)) { gOk = false; gBad = r.label + '（P）'; }
    });
    add('产生项 = 60000 × 人数 × 每人产生率', gOk, gBad || '逐段重算一致（1 L/min = 0.06 m³/h，×1e6 → ppm·m³/h）');

    const rev = extra && extra.rev;
    if (rev && rev.feasible) {
      const bad = rev.params.filter((p) => !p.recheckOk);
      add('反推解回代后达标', bad.length === 0,
        bad.length ? bad.map((p) => p.label).join('、') + ' 回代后仍未达标' : rev.params.length + ' 项回代全部达标');
    } else {
      add('反推解回代后达标', true, '本次没有可落地的反推（' + ((rev && rev.reason) ? rev.reason.slice(0, 40) + '…' : '未运行') + '）');
    }

    const cyc = extra && extra.cyc;
    if (cyc) {
      const noAir = rows.every((r) => !(r.Q > 0));
      let pass, detail;
      if (cyc.converged && noAir && Math.abs(cyc.A) <= 1e-9) {
        pass = true; detail = cyc.reason + '（收缩因子 B = 1、净增 A = 0）';
      } else if (cyc.converged) {
        const back = simulateFrom(c, V, cyc.cStar).end;
        const err = Math.abs(back - cyc.cStar);
        pass = Math.abs(cyc.B - extra.decayFactor) <= 1e-12 && err <= Math.max(1e-9, Math.abs(cyc.cStar) * 1e-12);
        detail = '闭式不动点 C* = A/(1−B)：B = ' + cyc.B.toExponential(6) + '、A = ' + fmtC0(cyc.A) +
          '、C* = ' + fmtC0(cyc.cStar) + '；回代 F(C*) − C* = ' + err.toExponential(2) + ' ppm' +
          (cyc.usable ? '' : '（C* 超过 100%，物理上不可持续，判定改用第一天口径）');
      } else {
        pass = noAir && !(Math.abs(cyc.A) <= 1e-9);
        detail = cyc.reason + '（这是如实报告，不是算不出来）';
      }
      add('稳定日循环：闭式不动点 + 回代验证', pass, detail);
    } else add('稳定日循环：闭式不动点 + 回代验证', true, '未运行');

    const finiteOk = [V, kp.peak, kp.end, kp.overMin, sim.end].every((x) => isFinite(x)) && rows.every((r) => [r.Q, r.cIn, r.cOut, r.overMin].every((x) => isFinite(x)));
    add('输出契约：对外数字全部有限', finiteOk, finiteOk ? '全部有限' : '存在非有限值');

    return chk;
  }

  /* ── 主分析 ─────────────────────────────────────── */
  function analyze(cfg) {
    const c = normCfg(cfg);
    const errors = validate(c);
    if (errors.length) {
      return { ok: false, errors: errors, rows: [], curve: [], checks: [], insights: [], steps: [], sens: [], params: [], kpis: null, cyc: null, verdict: null, rev: null };
    }
    const V = c.area * c.height;
    const sim = simulateFrom(c, V, c.c0);
    const kpis = kpisOf(c, sim.rows, sim.curve, c.c0, sim.end);
    const cyc = cycleOf(c, V, c.c0);
    const cycKpis = kpisOf(c, cyc.rows, cyc.curve, cyc.start, cyc.end);
    const maxConc = kpis.peak;
    if (!(maxConc < CONC_LIMIT)) {
      return {
        ok: false,
        errors: [{
          field: 'segments',
          msg: '按当前参数，房间里的 CO₂ 会算到 ' + fmtC0(maxConc) + ' ppm（等于 ' + fmtFix(maxConc / 1e6 * 100, 1) +
            '% 的体积分数），这已经超出本页模型能表示的适用范围。请检查人数、每人产生率与通风量：' +
            '多半是人数/强度填大了，或者通风量（换气次数、机械新风）填得太小——本页不会把这种数当成结果给你看。'
        }],
        rows: [], curve: [], checks: [], insights: [], steps: [], sens: [], params: [], kpis: null, cyc: null, verdict: null, rev: null
      };
    }
    const basePeak = cyc.usable ? cyc.peak : kpis.peak;
    const verdict = verdictOf(basePeak, c.target);
    const rev = reverseSolve(c, V, sim.rows, Math.max(kpis.peak, cyc.usable ? cyc.peak : kpis.peak), c.target);
    const extra = { rev: rev, cyc: cyc, decayFactor: decayFactorOf(c, V) };
    const res = {
      ok: true, errors: [], cfg: c, V: V,
      rows: sim.rows, curve: sim.curve, end: sim.end, kpis: kpis,
      cyc: {
        converged: cyc.converged, usable: cyc.usable, reason: cyc.reason, cStar: cyc.cStar, B: cyc.B, A: cyc.A,
        days: cyc.days, iters: cyc.iters, start: cyc.start, end: cyc.end, gap: cyc.gap,
        peak: cyc.peak, rows: cyc.rows, curve: cyc.curve, kpis: cycKpis
      },
      verdict: verdict, rev: rev,
      checks: [], insights: [], steps: [], sens: [], params: rev.params
    };
    res.sens = sensitivity(c, V, {
      peak: kpis.peak, overMin: kpis.overMin, end: sim.end, verdict: verdict,
      cycPeak: cyc.usable ? cyc.peak : kpis.peak, cycOver: cyc.usable ? cycKpis.overMin : kpis.overMin
    });
    res.checks = runChecks(c, V, sim, extra);
    res.insights = insightsOf(c, V, res);
    res.steps = stepsOf(c, V, res);
    return res;
  }

  /* ── 需要记住的几条（全部由本次结果算出） ────────── */
  function insightsOf(c, V, res) {
    const out = [];
    const kp = res.kpis, cyc = res.cyc, rows = res.rows;
    const heaviest = rows.slice().sort((a, b) => (b.P - a.P) || (b.cOut - a.cOut))[0];

    out.push({
      t: '稳态浓度只由「产生率 ÷ 风量」决定，房间多大只决定「多久涨上去」',
      d: 'C_ss = 室外 ' + fmtC0(c.cAtm) + ' + 产生项 P ÷ 通风量 Q，式子里没有房间体积；体积只出现在时间常数 τ = V/Q 里。' +
        '产生最多的「' + heaviest.label + '」：P = ' + fmtC0(heaviest.P) + '、Q = ' + fmtQ(heaviest.Q) + ' → 稳态 ' + fmtC0(heaviest.css) +
        '，τ = ' + fmtHrs(heaviest.tau) + '。所以「换个房间」不解决闷，「加风量」才解决；房间大只让你晚一点到达同一个值。'
    });

    const df = decayFactorOf(c, V);
    if (cyc.converged && !cyc.usable) {
      out.push({
        t: '长期看这间屋子会积到物理上不可能的浓度',
        d: '换气量太小（一天的收缩因子 B = ' + cyc.B.toExponential(3) + '，几乎不留痕），把一天的时间线反复推下去，日循环的不动点是 ' +
          fmtC0(cyc.cStar) + ' ppm——超过 100% 的体积分数是不可能的，说明<b>这个换气量在长期不可持续</b>。' +
          '所以判定改用「第一天」的口径（峰值 ' + fmtC0(kp.peak) + '），并在这里如实说明，而不是拿这个数当结论。'
      });
    } else if (cyc.converged) {
      if (cyc.peak > kp.peak + 5) {
        out.push({
          t: '长期住下去，峰值比第一晚更高',
          d: '第一天从 ' + fmtC0(kp.c0) + ' 出发，峰值 ' + fmtC0(kp.peak) + '；日循环的不动点是 ' + fmtC0(cyc.start) +
            '（闭式解 C* = A/(1−B)，回代偏差 ' + Math.abs(cyc.gap).toExponential(2) + ' ppm' +
            (cyc.days ? '，从你填的起点按天迭代约需 ' + cyc.days + ' 天收敛到 1 ppm 以内' : '') +
            '），稳定峰值 ' + fmtC0(cyc.peak) + '——晚上回来的人把起跑线抬高了。判定用的是稳定日循环的峰值。'
        });
      } else {
        out.push({
          t: '一天下来，起点几乎被完全「洗掉」',
          d: '第一天从 ' + fmtC0(kp.c0) + ' 出发、峰值 ' + fmtC0(kp.peak) + '；日循环不动点 ' + fmtC0(cyc.start) +
            '、峰值 ' + fmtC0(cyc.peak) + '，与第一晚只差 ' + fmtFix(Math.abs(cyc.peak - kp.peak), 3) + ' ppm' +
            (cyc.days ? '（从你填的起点按天迭代约需 ' + cyc.days + ' 天收敛）' : '') +
            '。原因是一天的累计换气把初始浓度乘上了 ∏exp(−时长/τ) ≈ ' + df.toExponential(2) +
            '。所以「今晚临睡前开一次窗」只影响今晚，「长期闷不闷」由每天的通风总量决定。'
        });
      }
    } else {
      out.push({
        t: '这本账没有稳定日循环',
        d: '所有时段的通风量都是 0 时，浓度一段段线性累加（每人每小时给房间加 ' + fmtC0(60000 / V) +
          ' ppm 的量级），第一天还没跑完就已经到 ' + fmtC0(kp.peak) + '，不存在「每天重复的稳态」。页面如实标为不收敛。'
      });
    }

    const clean = rows.filter((r) => r.open)[0];
    const closed = rows.filter((r) => !r.open && r.hours > 0)[0];
    if (clean && closed) {
      const eOpen = clean.ach * clean.hours, eClosed = closed.ach * closed.hours;
      out.push({
        t: '开窗的账要按「换气次数 × 时长」算，不是按时长算',
        d: '开窗 ' + fmtHrs(clean.hours) + '（' + fmtACH(clean.ach) + '）换了 ' + fmtFix(eOpen, 2) + ' 次空气；' +
          '关窗 ' + fmtHrs(closed.hours) + '（' + fmtACH(closed.ach) + '）只换 ' + fmtFix(eClosed, 2) + ' 次。' +
          '按这个口径，关窗要 ' + fmtHrs(eOpen / Math.max(1e-9, closed.ach)) + ' 才顶得上这一次开窗。'
      });
    }

    const c2 = Object.assign({}, c, { cadr: 300 });
    const sim2 = simulateFrom(c2, V, c2.c0);
    const identical = Math.abs(sim2.end - res.end) < 1e-12 && sim2.rows.every((r, i) => Math.abs(r.cOut - rows[i].cOut) < 1e-12);
    out.push({
      t: '净化器（CADR）在这本账里的贡献正好是 0',
      d: '把 CADR 从 ' + fmtFix(c.cadr, 0) + ' 改成 300 m³/h，逐个时段重算后段末浓度' + (identical ? '一点没变' : '有变化（异常，请看自检）') +
        '（' + fmtC0(res.end) + '）。质量平衡里 CO₂ 只能靠换气带走，滤网不认 CO₂——' + fmtQ(c.cadr) + ' 的整机风量是内循环，不进账。' +
        '（本页把 CADR 当对照项，不参与任何计算。）'
    });

    const worst = rows.slice().sort((a, b) => b.cOut - a.cOut)[0];
    if (worst && worst.people > 0) {
      const gapAdd = 0.50;
      const c3 = Object.assign({}, c, { achClosed: c.achClosed + gapAdd });
      const sim3 = simulateFrom(c3, V, c3.c0);
      const kp3 = kpisOf(c3, sim3.rows, sim3.curve, c3.c0, sim3.end);
      out.push({
        t: '「留一条门缝」比「早点开窗」更省事',
        d: '把关窗换气次数从 ' + fmtACH(c.achClosed) + ' 加到 ' + fmtACH(c.achClosed + gapAdd) + '（设计假设，常见门缝量级），第一天的峰值从 ' +
          fmtC0(kp.peak) + ' 降到 ' + fmtC0(kp3.peak) + '（' + fmtPct((kp3.peak - kp.peak) / Math.max(1e-9, kp.peak - c.cAtm) * 100, 1) +
          ' 的「超出室外部分」被削掉）。'
      });
    }

    if (res.rev.feasible) {
      const p = res.rev.params.filter((x) => x.key === 'per')[0];
      out.push({
        t: '要压到 ' + fmtC0(c.target) + '，最重的时段每人需要 ' + fmtQ(p.value) + ' 新风',
        d: '反推自「' + res.rev.worst.label + '」：Q_req = P ÷（目标 − 室外）= ' + fmtC0(res.rev.worst.P) + ' ÷ ' +
          fmtC0(c.target - c.cAtm) + ' = ' + fmtQ(res.rev.Qreq) + '；这是稳态口径，回代后稳态 ' + fmtC0(p.recheck) +
          '（≤ 目标 ' + fmtC0(c.target) + '）。'
      });
    } else {
      out.push({ t: '按当前目标，换气压不下去', d: res.rev.reason });
    }
    return out;
  }

  /* ── 下一步（能作用到输入的建议） ────────────────── */
  function stepsOf(c, V, res) {
    const out = [];
    const rows = res.rows;
    const worst = rows.slice().sort((a, b) => b.cOut - a.cOut)[0];
    out.push('先看最闷的一段「' + worst.label + '」（' + worst.startClock + '–' + worst.endClock + '，' +
      worst.people + ' 人 · ' + worst.actShort + '）：段末 ' + fmtC0(worst.cOut) + '，这一段里有 ' + fmtFix(worst.overMin, 0) + ' 分钟高于目标。');
    if (res.rev.feasible) {
      res.rev.params.forEach((p) => {
        const unit = p.unit === '分钟' ? fmtFix(p.value, 0) + ' 分钟' : fmtAdaptive(p.value, p.unit, 2);
        const rawTxt = p.unit === '分钟' ? fmtFix(p.raw, 1) + ' 分钟' : fmtFix(p.raw, 2);
        out.push('「' + p.label + '」= ' + unit + (p.key === 'openMin' ? '（原始 ' + rawTxt + '，向上取整到分钟）' : '（原始 ' + rawTxt + '，向上取整）') +
          '，回代后 ' + (p.key === 'openMin' ? fmtC0(p.recheck) : '稳态 ' + fmtC0(p.recheck)) + (p.recheckOk ? '，达标' : '，仍未达标') + '。');
      });
      (res.rev.notes || []).forEach((x) => out.push(x));
    } else {
      out.push('按当前设置压不到目标：' + res.rev.reason);
    }
    const bad = res.sens.filter((r) => r.verdict.id === 'ok').map((r) => r.label);
    if (bad.length) out.push('敏感性表里能把判定拉回「够」的改法：' + bad.join('、') + '。');
    else out.push('敏感性表里没有任何一档能把判定拉回「够」——需要换更大的通风手段（机械新风、开窗面积、换房间）。');
    if (res.cyc.usable && res.cyc.peak > res.kpis.peak + 1) {
      out.push('注意「长期每天的峰值」（稳定日循环 ' + fmtC0(res.cyc.peak) + '）比「第一晚」（' + fmtC0(res.kpis.peak) + '）更高，' +
        '所以按长期口径留余量，别只按第一晚达标就收工。');
    }
    out.push('这些都只是「按你填的假设做的账」：每人产生率、换气次数、目标浓度都是假设，换一组假设结论就会变——' +
      '敏感性表里每一行都是完整重算的，不是插值。');
    return out;
  }

  /* ── 导出 ───────────────────────────────────────── */
  function csvText(res) {
    if (!res.ok) return '';
    const L = [];
    L.push('# 通风对账台 · 逐段表（DCB 批次 2026-11-11-codex-45）');
    L.push('# 房间：' + fmtFix(res.cfg.area, 2) + ' ㎡ × ' + fmtFix(res.cfg.height, 2) + ' m = ' + fmtVol(res.V) +
      '；室外 ' + fmtC0(res.cfg.cAtm) + '；目标 ' + fmtC0(res.cfg.target) + '；关窗 ' + fmtACH(res.cfg.achClosed) +
      '；开窗 ' + fmtACH(res.cfg.achOpen) + '；机械新风 ' + fmtQ(res.cfg.vent));
    L.push('段,时段,时长h,人数,活动,通风,换气次数次每h,通风量m3每h,产生项ppm*m3每h,tau_h,稳态ppm,段初ppm,段末ppm,超标分钟');
    res.rows.forEach((r) => {
      L.push([r.i + 1, r.startClock + '-' + r.endClock, r2(r.hours), r.people, r.actShort, r.ventName,
        r2(r.ach), r2(r.Q), r2(r.P), isFinite(r.tau) ? r2(r.tau) : 'Infinity', r2(r.css), r2(r.cIn), r2(r.cOut), r2(r.overMin)].join(','));
    });
    L.push('');
    L.push('# 24 小时曲线（每 ' + GRID_MIN + ' 分钟一个点；第一天从 ' + fmtC0(res.cfg.c0) + ' 出发）');
    L.push('t_h,浓度ppm,段号');
    const step = GRID_MIN / 60;
    for (let t = 0; t <= DAY_H + 1e-9; t += step) {
      const p = curveAt(res, t);
      L.push([r4(t), r2(p.c), p.i + 1].join(','));
    }
    L.push('');
    L.push('# 稳定日循环');
    if (res.cyc.converged) {
      L.push('迭代次数,' + res.cyc.iters + ',起点ppm,' + r2(res.cyc.start) + ',终点ppm,' + r2(res.cyc.end) + ',峰值ppm,' + r2(res.cyc.peak));
    } else L.push('不收敛（没有稳定日循环）');
    return L.join('\n');
  }
  function curveAt(res, t) {
    let best = res.curve[0];
    for (let i = 0; i < res.curve.length; i++) if (res.curve[i].t <= t + 1e-9) best = res.curve[i];
    return best || { c: NaN, i: -1 };
  }
  function mdText(res) {
    if (!res.ok) return '配置有误，无法导出。';
    const L = [];
    L.push('# 通风对账台 · 结果');
    L.push('');
    L.push('房间 ' + fmtFix(res.cfg.area, 2) + ' ㎡ × ' + fmtFix(res.cfg.height, 2) + ' m = ' + fmtVol(res.V) +
      '；室外 / 新风 ' + fmtC0(res.cfg.cAtm) + '；目标 ' + fmtC0(res.cfg.target) + '。');
    L.push('');
    L.push('## 结论');
    L.push('- 判定：**' + res.verdict.label + '**（' + res.verdict.detail + '）');
    L.push('- 第一天峰值 ' + fmtC0(res.kpis.peak) + '，高于目标的时长 ' + fmtMin(res.kpis.overMin) + '，末浓度 ' + fmtC0(res.kpis.end));
    if (res.cyc.converged) L.push('- 稳定日循环：起点 ' + fmtC0(res.cyc.start) + '、终点 ' + fmtC0(res.cyc.end) + '、峰值 ' + fmtC0(res.cyc.peak) + '（迭代 ' + res.cyc.iters + ' 次）');
    else L.push('- 稳定日循环：不收敛（浓度一直线性上涨）');
    L.push('');
    L.push('## 逐段账');
    L.push('| 段 | 时段 | 时长 h | 人数 | 活动 | 通风 | Q m³/h | τ h | 稳态 ppm | 段初 | 段末 | 超标分钟 |');
    L.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
    res.rows.forEach((r) => {
      L.push('| ' + (r.i + 1) + ' | ' + r.startClock + '–' + r.endClock + ' | ' + fmtFix(r.hours, 2) + ' | ' + r.people + ' | ' +
        r.actShort + ' | ' + r.ventName + ' | ' + fmtFix(r.Q, 2) + ' | ' + (isFinite(r.tau) ? fmtFix(r.tau, 2) : '∞') + ' | ' +
        fmtFix(r.css, 1) + ' | ' + fmtFix(r.cIn, 1) + ' | ' + fmtFix(r.cOut, 1) + ' | ' + fmtFix(r.overMin, 0) + ' |');
    });
    L.push('');
    L.push('## 要压到目标需要什么（反推，取整后已回代重算）');
    if (res.rev.feasible) {
      res.rev.params.forEach((p) => L.push('- ' + p.label + '：' + (p.unit === '分钟' ? fmtMin(p.value) : fmtAdaptive(p.value, p.unit, 2)) +
        '（原始 ' + fmtFix(p.raw, 2) + '）→ 回代 ' + fmtC0(p.recheck) + (p.recheckOk ? ' 达标' : ' 未达标')));
    } else L.push('- ' + res.rev.reason);
    L.push('');
    L.push('## 敏感性（每行完整重算）');
    L.push('| 改法 | 第一天峰值 ppm | 超标分钟 | 稳定峰值 ppm | 判定 |');
    L.push('|---|---|---|---|---|');
    res.sens.forEach((r) => L.push('| ' + r.label + ' | ' + fmtFix(r.peak, 0) + ' | ' + fmtFix(r.overMin, 0) + ' | ' + fmtFix(r.cycPeak, 0) + ' | ' + r.verdict.label + ' |'));
    L.push('');
    L.push('## 结构自检');
    res.checks.forEach((k) => L.push('- ' + (k.pass ? '✔' : '✘') + ' ' + k.name + '：' + k.detail));
    L.push('');
    L.push('## 边界');
    L.push('单区完全混合、定常产生与定常通风、一阶线性质量平衡；不建模空间不均匀、开窗风压热压、吸附与化学反应、温湿度与颗粒物；');
    L.push('净化器 CADR 在本账里贡献恒为 0；不引用也不替代任何标准条款；默认数据与内置场景均为虚构示例。');
    return L.join('\n');
  }
  function jsonBackup(res) {
    const d = defaultsClone();
    const cfg = res && res.ok ? res.cfg : d;
    return JSON.stringify({
      app: 'vent-ledger', title: '通风对账台', version: '1.0.0',
      savedAt: new Date().toISOString(),
      cfg: {
        area: cfg.area, height: cfg.height, c0: cfg.c0, cAtm: cfg.cAtm, target: cfg.target,
        achClosed: cfg.achClosed, achOpen: cfg.achOpen, vent: cfg.vent, cadr: cfg.cadr,
        startAt: cfg.startAt, g: cfg.g,
        segments: cfg.segments.map((s) => ({ label: s.label, hours: s.hours, people: s.people, act: s.act, open: s.open ? 1 : 0 }))
      }
    }, null, 2);
  }
  function readBackup(text) {
    const o = JSON.parse(text);
    const cfg = o && o.cfg ? o.cfg : o;
    if (!cfg || typeof cfg !== 'object' || (!Array.isArray(cfg.segments) && cfg.area === undefined)) {
      throw new Error('备份文件里没有可用的配置（缺 segments 与 area）');
    }
    return normCfg(cfg);
  }

  /* ── 内置场景（全部虚构） ─────────────────────────── */
  const scenarios = [
    { id: 'default', name: '默认：卧室 12 ㎡ · 关窗睡 8 小时', patch: {} },
    {
      id: 'sealed', name: '密封小卧室 8 ㎡ · 关窗 0.20', patch: {
        area: 8, height: 2.60, achClosed: 0.20
      }
    },
    {
      id: 'doorgap', name: '留一条门缝 · 关窗 0.80', patch: { achClosed: 0.80 }
    },
    {
      id: 'freshair', name: '关窗 + 机械新风 30 m³/h', patch: { vent: 30 }
    },
    {
      id: 'purifier', name: '只开净化器（CADR 300，换气 0.20）· 对照', patch: { cadr: 300, achClosed: 0.20 }
    },
    {
      id: 'meeting', name: '8 人会议室 4 小时 · 30 ㎡', patch: {
        area: 30, height: 2.80, achClosed: 0.50, achOpen: 12, target: 1000, c0: 600,
        segments: [
          { label: '会前无人', hours: 9.00, people: 0, act: 'sit', open: 0 },
          { label: '8 人开会', hours: 4.00, people: 8, act: 'sit', open: 0 },
          { label: '散会后开窗', hours: 0.50, people: 0, act: 'sit', open: 1 },
          { label: '会后关窗', hours: 10.50, people: 0, act: 'sit', open: 0 }
        ]
      }
    },
    {
      id: 'acsummer', name: '夏天空调房 · 整夜关窗 0.15', patch: {
        achClosed: 0.15, achOpen: 8, c0: 450
      }
    },
    {
      id: 'cabin', name: '车内容积 5 m³ · 2 人 1 小时', patch: {
        area: 2.0, height: 2.50, c0: 500, achClosed: 1.0, achOpen: 20,
        segments: [
          { label: '停车无人', hours: 12.00, people: 0, act: 'sit', open: 0 },
          { label: '两人车内', hours: 1.00, people: 2, act: 'sit', open: 0 },
          { label: '开窗行驶', hours: 0.50, people: 2, act: 'sit', open: 1 },
          { label: '停车无人', hours: 10.50, people: 0, act: 'sit', open: 0 }
        ]
      }
    },
    {
      id: 'novent', name: '零通风（ACH 0）· 1 人 8 小时 · 不收敛', patch: {
        achClosed: 0, achOpen: 0, vent: 0
      }
    }
  ];
  function scenarioCfg(id) {
    const hit = scenarios.filter((s) => s.id === id)[0] || scenarios[0];
    const d = defaultsClone();
    Object.keys(hit.patch).forEach((k) => {
      if (k === 'segments') d.segments = hit.patch.segments.map((s) => Object.assign({}, s));
      else if (k === 'g') d.g = Object.assign({}, d.g, hit.patch.g);
      else d[k] = hit.patch[k];
    });
    return d;
  }

  const LIMITS = {
    AREA_MIN: AREA_MIN, AREA_MAX: AREA_MAX, H_MIN: H_MIN, H_MAX: H_MAX,
    C0_MIN: C0_MIN, C0_MAX: C0_MAX, CATM_MIN: CATM_MIN, CATM_MAX: CATM_MAX,
    TGT_GAP_MIN: TGT_GAP_MIN, TGT_MAX: TGT_MAX, ACHC_MIN: ACHC_MIN, ACHC_MAX: ACHC_MAX,
    ACHO_MIN: ACHO_MIN, ACHO_MAX: ACHO_MAX, VENT_MIN: VENT_MIN, VENT_MAX: VENT_MAX,
    CADR_MIN: CADR_MIN, CADR_MAX: CADR_MAX, G_MIN: G_MIN, G_MAX: G_MAX,
    SEG_MAX: SEG_MAX, SEG_H_MIN: SEG_H_MIN, SEG_H_MAX: SEG_H_MAX,
    PEOPLE_MIN: PEOPLE_MIN, PEOPLE_MAX: PEOPLE_MAX, DAY_H: DAY_H,
    QREQ_MAX: QREQ_MAX, CONC_LIMIT: CONC_LIMIT, CYCLE_TOL: CYCLE_TOL, CYCLE_MAX: CYCLE_MAX,
    VERDICT_FACTOR: VERDICT_FACTOR, GRID_MIN: GRID_MIN
  };

  const api = {
    APP: 'vent-ledger', VERSION: '1.0.0',
    ACTIVITIES: ACTIVITIES, actOf: actOf, LIMITS: LIMITS,
    defaults: defaults, defaultsClone: defaultsClone, normCfg: normCfg, validate: validate,
    parseNum: parseNum, num: num, scenarios: scenarios, scenarioCfg: scenarioCfg,
    parseClock: parseClock, clockAt: clockAt,
    concAt: concAt, crossTime: crossTime, overMinutes: overMinutes,
    rk4Segment: rk4Segment, rk4Steps: rk4Steps, simulateFrom: simulateFrom, kpisOf: kpisOf,
    cycleOf: cycleOf, verdictOf: verdictOf, reverseSolve: reverseSolve,
    sensitivity: sensitivity, runChecks: runChecks, analyze: analyze,
    personG: personG, segSumG: segSumG, segP: segP, segQ: segQ,
    csvText: csvText, mdText: mdText, jsonBackup: jsonBackup, readBackup: readBackup,
    fmtC: fmtC, fmtC0: fmtC0, fmtVol: fmtVol, fmtQ: fmtQ, fmtACH: fmtACH, fmtHrs: fmtHrs,
    fmtMin: fmtMin, fmtPct: fmtPct, fmtRatio: fmtRatio, fmtG: fmtG, fmtFix: fmtFix, fmtAdaptive: fmtAdaptive,
    r2: r2, r4: r4, ceilTo: ceilTo
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AppCore = api;
})(typeof window !== 'undefined' ? window : null);
