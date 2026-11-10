/* 通风对账台 · 界面（vent-ledger）
 * 依赖 window.AppCore（core.js）。所有展示数字都来自同一次 analyze() 的结果。
 */
(function () {
  'use strict';
  const C = window.AppCore;
  const $ = (id) => document.getElementById(id);
  const STORE_KEY = 'vent-ledger:v1';
  const GKEYS = ['sleep', 'sit', 'light', 'medium', 'sport'];

  const state = { cfg: null, res: null, view: 'day', exports: 0, renders: 0 };

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const PILL = { ok: 'ok', tight: 'tight', bad: 'bad' };
  const pill = (v) => '<span class="pill ' + (PILL[v && v.id] || 'tight') + '">' + esc(v ? v.label : '—') + '</span>';
  const fmtU = (x, u) => C.fmtAdaptive(x, u, 2);
  const fmtMinTxt = (m) => {
    if (!isFinite(m)) return '—';
    if (m < 1) return C.fmtFix(m, 2) + ' 分钟';
    if (m < 60) return C.fmtFix(m, 0) + ' 分钟';
    const h = Math.floor(m / 60), mm = Math.round(m - h * 60);
    return h + ' 小时 ' + (mm < 60 ? mm + ' 分钟' : '');
  };

  function toast(msg) {
    let t = $('toast');
    if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
    t.textContent = msg;
    t.style.opacity = '1';
    clearTimeout(t._h);
    t._h = setTimeout(() => { t.style.opacity = '0'; }, 2100);
  }

  /* ── 读写配置 ───────────────────────────────────── */
  function readCfg() {
    const g = (id) => { const el = $(id); return el ? el.value : undefined; };
    const segs = [];
    document.querySelectorAll('#segments .item').forEach((el) => {
      const i = el.getAttribute('data-seg');
      segs.push({
        label: (g('s-label-' + i) || '').trim(),
        hours: g('s-hours-' + i), people: g('s-people-' + i),
        act: g('s-act-' + i), open: g('s-open-' + i) === '1' ? 1 : 0
      });
    });
    const cfg = {
      area: g('area'), height: g('height'), c0: g('c0'), cAtm: g('cAtm'), target: g('target'),
      achClosed: g('achClosed'), achOpen: g('achOpen'), vent: g('vent'), cadr: g('cadr'),
      startAt: g('startAt'), g: {}, segments: segs
    };
    GKEYS.forEach((k) => { cfg.g[k] = g('g-' + k); });
    return cfg;
  }
  function fillCfg(cfg) {
    const c = C.normCfg(cfg);
    const set = (id, v) => { const el = $(id); if (el) el.value = (v === undefined || v === null) ? '' : String(v); };
    ['area', 'height', 'c0', 'cAtm', 'target', 'achClosed', 'achOpen', 'vent', 'cadr', 'startAt'].forEach((k) => set(k, c[k]));
    GKEYS.forEach((k) => set('g-' + k, c.g[k]));
    state.cfg = c;
    renderSegments(c.segments);
  }
  function segOptions(act, open) {
    const acts = C.ACTIVITIES.map((a) => '<option value="' + a.id + '"' + (a.id === act ? ' selected' : '') + '>' + esc(a.name) + '</option>').join('');
    const opens = '<option value="0"' + (open ? '' : ' selected') + '>关窗</option><option value="1"' + (open ? ' selected' : '') + '>开窗</option>';
    return { acts: acts, opens: opens };
  }
  function renderSegments(segs) {
    const start = C.parseClock(state.cfg.startAt);
    let acc = 0;
    const html = segs.map((s, i) => {
      const o = segOptions(s.act, s.open);
      const t0 = isFinite(start) ? C.clockAt(start, acc) : '--:--';
      acc += isFinite(s.hours) ? s.hours : 0;
      const t1 = isFinite(start) ? C.clockAt(start, acc) : '--:--';
      return '<div class="item" data-seg="' + i + '">' +
        '<div class="itemhead">' +
        '<span class="idx">' + (i + 1) + ' · ' + t0 + '–' + t1 + '</span>' +
        '<input type="text" id="s-label-' + i + '" value="' + esc(s.label) + '" maxlength="18" placeholder="这一段叫什么">' +
        '<select id="s-open-' + i + '">' + o.opens + '</select>' +
        '<select id="s-act-' + i + '">' + o.acts + '</select>' +
        '</div><div class="gridf">' +
        '<label>时长（h）<input type="text" id="s-hours-' + i + '"></label>' +
        '<label>人数（人）<input type="text" id="s-people-' + i + '"></label>' +
        '</div></div>';
    }).join('');
    $('segments').innerHTML = html;
    segs.forEach((s, i) => {
      const h = $('s-hours-' + i), p = $('s-people-' + i);
      if (h) h.value = String(s.hours);
      if (p) p.value = String(s.people);
    });
    const tot = segs.reduce((a, s) => a + (isFinite(s.hours) ? s.hours : 0), 0);
    $('segCount').textContent = segs.length + ' / ' + C.LIMITS.SEG_MAX + ' 段';
    $('segTotal').textContent = C.fmtFix(tot, 2) + ' h';
    const gap = 24 - tot;
    $('segGap').innerHTML = Math.abs(gap) < 1e-6 ? '（正好一天）' :
      '<span class="bad">（' + (gap > 0 ? '还差 ' : '多了 ') + C.fmtFix(Math.abs(gap), 2) + ' h，需要正好 24.00 h）</span>';
  }

  /* ── 计算与渲染 ─────────────────────────────────── */
  function markCustom() {
    const el = $('scenario');
    if (el && el.value) el.value = '';
  }
  function compute() {
    state.cfg = C.normCfg(readCfg());
    const res = C.analyze(state.cfg);
    state.res = res;
    state.renders++;
    if (!res.ok) {
      $('errBox').innerHTML = '<div class="errbox"><b>还差一点，先修这几处：</b><ul>' +
        res.errors.map((e) => '<li>' + esc(e.msg) + '</li>').join('') + '</ul></div>';
      markBad(res.errors);
      $('resultCard').style.opacity = '.45';
      const cw = C.normCfg(readCfg());
      $('volTxt').textContent = (isFinite(cw.area) && isFinite(cw.height)) ? C.fmtVol(cw.area * cw.height) + '（面积 × 净层高）' : '—';
      return;
    }
    $('errBox').innerHTML = '';
    markBad([]);
    $('resultCard').style.opacity = '1';
    renderAll(res);
    saveLocal(true);
  }
  function markBad(errors) {
    document.querySelectorAll('input.bad,select.bad').forEach((el) => el.classList.remove('bad'));
    errors.forEach((e) => {
      let id = e.field;
      if (id === 'startAt') id = 'startAt';
      else if (id.indexOf('g.') === 0) id = 'g-' + id.slice(2);
      else if (id.indexOf('seg') === 0) {
        const m = /^seg(\d+)\.(\w+)$/.exec(id);
        if (m) id = (m[2] === 'hours' ? 's-hours-' : m[2] === 'people' ? 's-people-' : m[2] === 'act' ? 's-act-' : 's-label-') + m[1];
      }
      const el = $(id);
      if (el) el.classList.add('bad');
    });
  }
  function cur() {
    const res = state.res;
    if (!res || !res.ok) return null;
    if (state.view === 'cycle' && res.cyc) return { rows: res.cyc.rows, curve: res.cyc.curve, kpis: res.cyc.kpis, label: '稳定日循环', cycle: true };
    return { rows: res.rows, curve: res.curve, kpis: res.kpis, label: '第一天', cycle: false };
  }

  function renderAll(res) {
    const v = cur();
    $('volTxt').textContent = C.fmtVol(res.V) + '（面积 × 净层高）';
    // 结论
    $('verdictPill').innerHTML = pill(res.verdict);
    const cycTxt = (res.cyc.converged && res.cyc.usable)
      ? '不动点 ' + C.fmtC0(res.cyc.start) + ' → 峰值 ' + C.fmtC0(res.cyc.peak) +
        '（闭式解 C* = A/(1−B)，B = ' + res.cyc.B.toExponential(2) + '，回代偏差 ' + Math.abs(res.cyc.gap).toExponential(1) + ' ppm' +
        (res.cyc.days ? '，按天迭代约 ' + res.cyc.days + ' 天收敛' : '') + '）'
      : (res.cyc.converged
        ? '<b>长期不可持续</b>：不动点 ' + C.fmtC0(res.cyc.cStar) + ' ppm 超过 100%，判定改用第一天口径（B = ' + res.cyc.B.toExponential(2) + '，几乎不留痕）'
        : '<b>不存在日循环</b>：' + esc(res.cyc.reason || ''));
    $('verdictDetail').innerHTML =
      '<span class="k">判定依据</span><span>' + esc(res.verdict.detail) + '（按' + (res.cyc.usable ? '稳定日循环的峰值' : '第一天的峰值') + '判）</span>' +
      '<span class="k">第一天</span><span>峰值 ' + C.fmtC0(res.kpis.peak) + '，高于目标的时长 ' + fmtMinTxt(res.kpis.overMin) + '，末浓度 ' + C.fmtC0(res.kpis.end) + '</span>' +
      '<span class="k">日循环</span><span>' + cycTxt + '</span>' +
      '<span class="k">房间</span><span>' + C.fmtFix(res.cfg.area, 2) + ' ㎡ × ' + C.fmtFix(res.cfg.height, 2) + ' m → ' + C.fmtVol(res.V) +
      '；室外 ' + C.fmtC0(res.cfg.cAtm) + '；目标 ' + C.fmtC0(res.cfg.target) + '</span>';
    $('baselineNote').innerHTML = '判定用的峰值是<b>' + (res.cyc.usable ? '稳定日循环' : '第一天') + '</b>的；三档的门槛（目标、目标 ×' +
      C.LIMITS.VERDICT_FACTOR + '）是<b>设计选择</b>，不是任何标准的限值。默认数据与 9 个内置场景全部是虚构示例。';

    // KPI
    const k = v.kpis;
    $('kpis').innerHTML = [
      ['峰值（' + v.label + '）', C.fmtC0(k.peak), k.peak > res.cfg.target ? '高于目标 ' + C.fmtC0(res.cfg.target) : '不超过目标 ' + C.fmtC0(res.cfg.target)],
      ['高于目标的时长', fmtMinTxt(k.overMin), '占一天 ' + C.fmtPct(k.overMin / 1440 * 100, 1)],
      ['最低浓度', C.fmtC0(k.min), '室外 ' + C.fmtC0(res.cfg.cAtm)],
      ['末浓度', C.fmtC0(k.end), k.cycle ? '与起点差 ' + C.fmtFix(k.gap, 4) + ' ppm' : '与起点差 ' + C.fmtFix(k.gap, 2) + ' ppm']
    ].map(([lab, val, note]) => '<div class="kpi"><div class="lab">' + esc(lab) + '</div><div class="val">' + esc(val) + '</div><div class="note">' + esc(note) + '</div></div>').join('');

    // 曲线
    renderChart(res, v);

    // 要点
    $('insights').innerHTML = res.insights.map((x) => '<li><b>' + esc(x.t) + '</b><span>' + esc(x.d) + '</span></li>').join('');

    // 下一步
    $('steps').innerHTML = res.steps.map((s) => '<li>' + esc(s) + '</li>').join('');

    // 反推
    renderRev(res);

    // 逐段表
    renderSegTables(res, v);

    // 敏感性
    $('sensBody').innerHTML = res.sens.map((r) => '<tr' + (r.delta === 0 ? ' class="sel"' : '') + '><td>' + esc(r.label) + '</td><td>' + esc(C.fmtFix(r.peak, 0)) +
      '</td><td>' + esc(C.fmtFix(r.overMin, 0)) + '</td><td>' + esc(C.fmtFix(r.cycPeak, 0)) + '</td><td>' + pill(r.verdict) + '</td></tr>').join('');

    // 自检
    const passN = res.checks.filter((c) => c.pass).length;
    $('checkTag').textContent = passN + ' / ' + res.checks.length + ' 通过';
    $('checks').innerHTML = res.checks.map((c) => '<li class="' + (c.pass ? '' : 'no') + '">' + (c.pass ? '✔' : '✘') + ' <b>' + esc(c.name) + '</b>：' + esc(c.detail) + '</li>').join('');
    const canCycle = !!(res.cyc && res.cyc.usable);
    $('btnViewCycle').disabled = !canCycle;
    $('btnViewCycle').style.opacity = canCycle ? '1' : '.5';
  }

  function renderSegTables(res, v) {
    $('segBody').innerHTML = v.rows.map((r) => '<tr><td>' + esc(r.label) + '</td><td>' + esc(r.startClock + '–' + r.endClock) + '</td><td>' + esc(C.fmtFix(r.hours, 2)) +
      '</td><td>' + r.people + '</td><td>' + esc(r.actShort) + '</td><td>' + esc(r.ventName) + '</td><td>' + esc(C.fmtFix(r.Q, 2)) + '</td><td>' + esc(C.fmtFix(r.cOut, 0)) + '</td></tr>').join('');
    const totH = v.rows.reduce((a, r) => a + r.hours, 0);
    const totP = v.rows.reduce((a, r) => a + r.people * r.hours, 0);
    const totQ = v.rows.reduce((a, r) => a + r.Q, 0);
    $('tfPeriod').textContent = v.rows.length ? v.rows[0].startClock + '–' + v.rows[v.rows.length - 1].endClock : '—';
    $('tfHours').textContent = C.fmtFix(totH, 2);
    $('tfOver').innerHTML = '人·h <b>' + esc(C.fmtFix(totP, 1)) + '</b>　高于目标 <b>' + esc(fmtMinTxt(v.kpis.overMin)) + '</b>';
    $('tfQ').textContent = C.fmtFix(totQ / Math.max(1, v.rows.length), 2) + ' 均';
    $('tfEnd').textContent = C.fmtFix(v.kpis.end, 0);
    $('segBody2').innerHTML = v.rows.map((r) => '<tr><td>' + esc(r.label) + '</td><td>' + esc(C.fmtFix(r.ach, 2)) + '</td><td>' +
      esc(isFinite(r.tau) ? C.fmtFix(r.tau, 3) : '∞') + '</td><td>' + esc(isFinite(r.css) ? C.fmtFix(r.css, 1) : '∞') + '</td><td>' +
      esc(C.fmtFix(r.cIn, 1)) + '</td><td>' + esc(C.fmtFix(r.overMin, 1)) + '</td></tr>').join('');
  }

  function renderRev(res) {
    const rev = res.rev;
    if (!rev || !rev.feasible) {
      $('revTag').textContent = '不可行';
      $('revBox').innerHTML = '<div class="warnbox">' + esc(rev ? rev.reason : '未运行') + '</div>';
      return;
    }
    $('revTag').textContent = '针对「' + rev.worst.label + '」';
    const rows = rev.params.map((p) => {
      const isMin = p.unit === '分钟';
      const val = isMin ? C.fmtFix(p.value, 0) + ' 分钟' : fmtU(p.value, p.unit);
      const raw = isMin ? C.fmtFix(p.raw, 1) + ' 分钟' : C.fmtFix(p.raw, 2) + ' ' + p.unit;
      let btn = '';
      if (p.key === 'ach') btn = '<button class="tiny" data-apply="ach" data-val="' + p.value + '">把关窗换气次数设为 ' + C.fmtFix(p.value, 2) + '</button>';
      else if (p.key === 'vent') btn = '<button class="tiny" data-apply="vent" data-val="' + p.value + '">机械新风 +' + C.fmtFix(p.value, 0) + ' m³/h</button>';
      else if (p.key === 'openMin') btn = '<button class="tiny" data-apply="open" data-val="' + p.value + '">把开窗段设成 ' + C.fmtFix(p.value, 0) + ' 分钟</button>';
      return '<tr><td>' + esc(p.label) + '<div class="footnote" style="margin:2px 0 0">' + esc(p.note) + '</div></td>' +
        '<td>' + esc(val) + '<div class="footnote" style="margin:2px 0 0">原始 ' + esc(raw) + '</div></td>' +
        '<td>' + esc(fmtU(p.recheck, 'ppm')) + (p.recheckOk ? ' ✔' : ' ✘') + (btn ? '<div style="margin-top:5px">' + btn + '</div>' : '') + '</td></tr>';
    }).join('');
    $('revBox').innerHTML = '<div class="tw"><table id="revTable"><thead><tr><th>要什么</th><th>取整后的建议</th><th>回代重算</th></tr></thead><tbody>' +
      rows + '</tbody></table></div>' +
      ((rev.notes || []).length ? '<div class="warnbox">' + rev.notes.map(esc).join('<br>') + '</div>' : '') +
      '<p class="footnote">反推全部按稳态口径算 <code>Q_req = 产生项 ÷（目标 − 室外）</code>，并一律朝「更能达标」的方向取整（风量到 1 m³/h、换气次数到 0.01、每人风量到 1、开窗到 1 分钟），取整后<b>回代重算</b>，不达标就标出来。' +
      '「每人需要新风」是参考值，页面上没有对应输入框，所以不给按钮。</p>';
  }

  /* ── 曲线（内联 SVG） ───────────────────────────── */
  function renderChart(res, v) {
    const W = 800, H = 340, L = 66, R = 16, T = 16, B = 62;
    const pts = v.curve;
    let yMax = Math.max(v.kpis.peak, res.cfg.target) * 1.08;
    let yMin = Math.min(res.cfg.cAtm, v.kpis.min) - 40;
    yMin = Math.max(0, yMin);
    if (!(yMax > yMin)) yMax = yMin + 100;
    const X = (t) => L + (W - L - R) * (t / 24);
    const Y = (c) => T + (H - T - B) * (1 - (clamp(c, yMin, yMax) - yMin) / (yMax - yMin));
    let s = '<svg id="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="24 小时 CO₂ 浓度曲线">';
    s += '<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="#fff"/>';
    // 时段底色
    let acc = 0;
    v.rows.forEach((r) => {
      const x0 = X(acc), x1 = X(acc + r.hours);
      s += '<rect x="' + x0.toFixed(1) + '" y="' + T + '" width="' + Math.max(0.5, x1 - x0).toFixed(1) + '" height="' + (H - T - B) +
        '" fill="' + (r.open ? '#dcebf7' : '#eef2f6') + '"/>';
      acc += r.hours;
    });
    // y 网格
    for (let i = 0; i <= 4; i++) {
      const c = yMin + (yMax - yMin) * i / 4, y = Y(c);
      s += '<line x1="' + L + '" y1="' + y.toFixed(1) + '" x2="' + (W - R) + '" y2="' + y.toFixed(1) + '" stroke="#e8ecf1"/>';
      s += '<text x="' + (L - 8) + '" y="' + (y + 5).toFixed(1) + '" font-size="16" fill="#7b8794" text-anchor="end">' + C.fmtFix(c, 0) + '</text>';
    }
    // x 刻度
    for (let t = 0; t <= 24; t += 3) {
      const x = X(t);
      s += '<line x1="' + x.toFixed(1) + '" y1="' + (H - B) + '" x2="' + x.toFixed(1) + '" y2="' + (H - B + 5) + '" stroke="#cbd2da"/>';
      s += '<text x="' + x.toFixed(1) + '" y="' + (H - B + 24) + '" font-size="16" fill="#7b8794" text-anchor="middle">' + t + 'h</text>';
    }
    s += '<text x="' + L + '" y="' + (H - 8) + '" font-size="15" fill="#7b8794">从 ' + esc(res.cfg.startAt) + ' 起的 24 小时（虚线 = 目标 ' + esc(C.fmtC0(res.cfg.target)) + '）</text>';
    // 目标线
    if (res.cfg.target <= yMax) {
      const yt = Y(res.cfg.target);
      s += '<line x1="' + L + '" y1="' + yt.toFixed(1) + '" x2="' + (W - R) + '" y2="' + yt.toFixed(1) + '" stroke="#b42318" stroke-width="2" stroke-dasharray="7 5"/>';
    }
    // 曲线
    s += '<polyline fill="none" stroke="#0f5fa6" stroke-width="2.6" points="' +
      pts.map((p) => X(p.t).toFixed(1) + ',' + Y(p.c).toFixed(1)).join(' ') + '"/>';
    // 峰值点
    const pk = pts.reduce((m, p) => (p.c > m.c ? p : m), pts[0]);
    s += '<circle cx="' + X(pk.t).toFixed(1) + '" cy="' + Y(pk.c).toFixed(1) + '" r="5" fill="#0f7b52"/>';
    s += '<text x="' + clamp(X(pk.t), L + 6, W - 130).toFixed(1) + '" y="' + (Y(pk.c) - 12).toFixed(1) + '" font-size="16" font-weight="700" fill="#0f7b52">峰值 ' + esc(C.fmtC0(pk.c)) + '</text>';
    s += '</svg>';
    $('chart').innerHTML = s;
    $('curveTag').textContent = v.label + '（起点 ' + C.fmtC0(v.cycle ? res.cyc.start : res.cfg.c0) + '）';
  }

  /* ── 结果卡 PNG ─────────────────────────────────── */
  function wrap(g, text, x, y, maxW, lh) {
    const lines = [];
    let line = '';
    for (const ch of String(text)) {
      if (g.measureText(line + ch).width > maxW && line) { lines.push(line); line = ch; }
      else line += ch;
    }
    if (line) lines.push(line);
    lines.forEach((l, i) => g.fillText(l, x, y + i * lh));
    return y + lines.length * lh;
  }
  function pngCard() {
    const res = state.res;
    if (!res || !res.ok) return;
    const v = cur();
    const W = 1080, H = 1350;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#0f5fa6'; g.fillRect(0, 0, W, 12);
    g.textBaseline = 'alphabetic';
    let y = 84;
    g.fillStyle = '#161b22'; g.font = '700 52px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
    g.fillText('通风对账台', 60, y);
    g.font = '400 26px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
    g.fillStyle = '#4a5568';
    g.fillText('关窗睡一晚有多闷 · 开窗几分钟能压下来 · 新风要多大', 60, y + 44);
    y += 104;
    // 判定
    const col = res.verdict.id === 'ok' ? ['#e8f6ef', '#0f7b52'] : res.verdict.id === 'tight' ? ['#fff5e5', '#9a5b00'] : ['#fdeceb', '#b42318'];
    g.fillStyle = col[0]; g.fillRect(60, y, 960, 84);
    g.fillStyle = col[1]; g.font = '700 40px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
    g.fillText('判定：' + res.verdict.label, 84, y + 56);
    g.font = '400 24px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
    g.fillStyle = '#4a5568';
    g.fillText(v.label + '峰值 ' + C.fmtC0(v.kpis.peak) + ' · 高于目标 ' + C.fmtFix(v.kpis.overMin, 0) + ' 分钟', 470, y + 52);
    y += 116;
    // 房间行
    g.font = '400 26px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
    g.fillStyle = '#4a5568';
    /* 每行都要在 960 px 里放得下：长行一律自己折，不靠画布裁 */
    const info = [
      '房间 ' + C.fmtFix(res.cfg.area, 2) + ' ㎡ × ' + C.fmtFix(res.cfg.height, 2) + ' m = ' + C.fmtVol(res.V) +
        '　室外 ' + C.fmtC0(res.cfg.cAtm) + '　目标 ' + C.fmtC0(res.cfg.target),
      '关窗 ' + C.fmtACH(res.cfg.achClosed) + '　开窗 ' + C.fmtACH(res.cfg.achOpen) + '　机械新风 ' + C.fmtQ(res.cfg.vent),
      '净化器 CADR ' + C.fmtQ(res.cfg.cadr) + '（只做对照，在本账里贡献恒为 0）'
    ];
    info.forEach((ln, i) => {
      let fs = 26;
      g.font = '400 ' + fs + 'px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
      while (g.measureText(ln).width > 960 && fs > 17) { fs -= 1; g.font = '400 ' + fs + 'px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif'; }
      g.fillText(ln, 60, y + i * 34);
    });
    y += 34 * info.length + 8;
    // 曲线
    const cW = 960, cH = 300, cx = 60, cy = y;
    let yMax = Math.max(v.kpis.peak, res.cfg.target) * 1.06;
    let yMin = Math.max(0, Math.min(res.cfg.cAtm, v.kpis.min) - 40);
    if (!(yMax > yMin)) yMax = yMin + 100;
    const X = (t) => cx + cW * (t / 24);
    const Y = (c) => cy + cH * (1 - (clamp(c, yMin, yMax) - yMin) / (yMax - yMin));
    g.fillStyle = '#fafbfc'; g.fillRect(cx, cy, cW, cH);
    let acc = 0;
    v.rows.forEach((r) => {
      g.fillStyle = r.open ? '#dcebf7' : '#eef2f6';
      g.fillRect(X(acc), cy, Math.max(1, X(acc + r.hours) - X(acc)), cH);
      acc += r.hours;
    });
    g.strokeStyle = '#e8ecf1'; g.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const yy = cy + cH * i / 4;
      g.beginPath(); g.moveTo(cx, yy); g.lineTo(cx + cW, yy); g.stroke();
      g.fillStyle = '#7b8794'; g.font = '400 20px sans-serif';
      g.fillText(C.fmtFix(yMin + (yMax - yMin) * (4 - i) / 4, 0), cx + 6, yy + 24);
    }
    if (res.cfg.target <= yMax) {
      g.strokeStyle = '#b42318'; g.lineWidth = 3; g.setLineDash([10, 7]);
      g.beginPath(); g.moveTo(cx, Y(res.cfg.target)); g.lineTo(cx + cW, Y(res.cfg.target)); g.stroke();
      g.setLineDash([]);
    }
    g.strokeStyle = '#0f5fa6'; g.lineWidth = 4; g.beginPath();
    v.curve.forEach((p, i) => { const xx = X(p.t), yy = Y(p.c); if (i === 0) g.moveTo(xx, yy); else g.lineTo(xx, yy); });
    g.stroke();
    const pk = v.curve.reduce((m, p) => (p.c > m.c ? p : m), v.curve[0]);
    g.fillStyle = '#0f7b52'; g.beginPath(); g.arc(X(pk.t), Y(pk.c), 7, 0, Math.PI * 2); g.fill();
    y = cy + cH + 44;
    // 自下而上排布：先占住页脚，再往上填要点
    g.font = '400 22px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
    g.fillStyle = '#7b8794';
    const footY = H - 46;
    g.fillText('默认数据与内置场景均为虚构示例；不引用也不替代任何标准条款；净化器 CADR 在本账里贡献恒为 0。', 60, footY);
    let limit = footY - 40;
    // 要点：先算每一块需要多高，再从下往上放
    g.font = '400 24px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
    const blocks = res.insights.slice(0, 4).map((x) => {
      const lines = [];
      let line = '';
      for (const ch of x.d) {                       // 只排正文：标题单独画一行，不能重复
        if (g.measureText(line + ch).width > 940 && line) { lines.push(line); line = ch; }
        else line += ch;
      }
      if (line) lines.push(line);
      return { title: x.t, lines: lines };
    });
    let used = 0;
    const heights = blocks.map((b) => 34 + b.lines.length * 32 + 14);
    let take = 0;
    for (let i = 0; i < heights.length; i++) { if (used + heights[i] <= limit - y) { used += heights[i]; take++; } else break; }
    let by = limit - used;
    for (let i = 0; i < take; i++) {
      const b = blocks[i];
      let tf = 26;
      g.font = '700 ' + tf + 'px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
      while (g.measureText(b.title).width > 960 && tf > 18) { tf -= 1; g.font = '700 ' + tf + 'px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif'; }
      g.fillStyle = '#0f5fa6';
      g.fillText(b.title, 60, by + 24);
      g.fillStyle = '#4a5568'; g.font = '400 24px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
      b.lines.forEach((l, j) => g.fillText(l, 60, by + 62 + j * 32));
      by += heights[i];
    }
    cv.toBlob((b) => {
      const url = URL.createObjectURL(b);
      const a = document.createElement('a');
      a.href = url; a.download = '通风对账台-结果卡.png'; a.style.display = 'none';
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 4000);
      state.exports++;
    }, 'image/png', 0.94);
  }

  function download(name, text, type) {
    const blob = new Blob([text], { type: type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.style.display = 'none';
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 4000);
    state.exports++;
  }

  /* ── 本机保存 / 读取 / 导入 ─────────────────────── */
  function saveLocal(silent) {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(readCfg()));
      if (!silent) toast('已保存到本机（刷新后自动恢复）');
      $('storeNote').textContent = '已保存到本机（localStorage）——最后一次改动的时间：' + new Date().toLocaleString('zh-CN');
    } catch (e) { if (!silent) toast('本机保存失败：' + e.message); }
  }
  function loadLocal(showToast) {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) { if (showToast) toast('本机没有保存过的设置'); return false; }
      fillCfg(JSON.parse(raw));
      if (showToast) toast('已读取本机保存的设置');
      return true;
    } catch (e) { if (showToast) toast('读取失败：' + e.message); return false; }
  }
  function importBackup(file) {
    const fr = new FileReader();
    fr.onload = () => {
      try {
        const cfg = C.readBackup(String(fr.result));
        $('scenario').value = '';
        fillCfg(cfg);
        compute();
        toast('已导入备份并重算');
      } catch (e) { toast('导入失败：' + e.message); }
    };
    fr.readAsText(file);
  }

  /* ── 一键采用 ───────────────────────────────────── */
  function applyPatch(kind, val) {
    if (!state.res || !state.res.ok) return;
    const cfg = C.normCfg(readCfg());
    if (kind === 'ach') {
      cfg.achClosed = Math.round(val * 100) / 100;
      toast('关窗换气次数已设为 ' + C.fmtFix(cfg.achClosed, 2) + ' 次/h');
    } else if (kind === 'vent') {
      cfg.vent = Math.min(C.LIMITS.VENT_MAX, Math.round((numOf(cfg.vent) + val) * 100) / 100);
      toast('机械新风已设为 ' + C.fmtQ(cfg.vent));
    } else if (kind === 'open') {
      if (!applyOpenMinutes(cfg, val)) return;
    }
    $('scenario').value = '';
    fillCfg(cfg);
    compute();
  }
  const numOf = (v) => { const n = C.parseNum(v); return isFinite(n) ? n : 0; };
  function applyOpenMinutes(cfg, minutes) {
    const segs = cfg.segments.map((s) => Object.assign({}, s));
    const want = minutes / 60;
    // 找第一段「开窗且无人」的段作为落点；没有就找第一段开窗段
    let idx = segs.findIndex((s) => s.open && numOf(s.people) === 0);
    if (idx < 0) idx = segs.findIndex((s) => s.open);
    if (idx < 0) { toast('当前时段表里没有开窗段：先把某一段的通风改成「开窗」再试'); return false; }
    const old = numOf(segs[idx].hours);
    let delta = want - old;
    if (Math.abs(delta) < 1e-9) { toast('开窗段已经是这个时长'); return false; }
    // 从最长的一段里扣/补（优先无人关窗段），保持合计 24 h
    const donors = segs.map((s, i) => ({ s: s, i: i })).filter((x) => x.i !== idx)
      .sort((a, b) => (numOf(b.s.hours) - numOf(a.s.hours)));
    if (delta > 0) {
      // 需要更长的开窗：从最长的一段里扣
      let need = delta;
      for (const d of donors) {
        if (need <= 1e-9) break;
        const avail = numOf(d.s.hours) - 0.05;
        const take = Math.min(avail, need);
        if (take <= 1e-9) continue;
        d.s.hours = Math.round((numOf(d.s.hours) - take) * 1e4) / 1e4;
        need -= take;
        segs[d.i] = d.s;
      }
      if (need > 1e-9) { toast('时长不够挪：其他段都已到最短 0.05 h'); return false; }
      segs[idx].hours = Math.round((old + (delta - need)) * 1e4) / 1e4;
    } else {
      // 需要更短的开窗：多出来的时长补给最长的一段
      const d = donors[0];
      segs[idx].hours = Math.round(want * 1e4) / 1e4;
      d.s.hours = Math.round((numOf(d.s.hours) + (-delta)) * 1e4) / 1e4;
      segs[d.i] = d.s;
    }
    const tot = segs.reduce((a, s) => a + numOf(s.hours), 0);
    if (Math.abs(tot - 24) > 1e-4) { toast('挪完之后合计不是 24 h，已取消这次改动'); return false; }
    cfg.segments = segs;
    toast('已把「' + segs[idx].label + '」设成 ' + C.fmtFix(want * 60, 0) + ' 分钟，并从最长的一段挪了时长');
    return true;
  }

  /* ── 事件 ───────────────────────────────────────── */
  function bind() {
    document.querySelectorAll('input[type=text]').forEach((el) => {
      el.addEventListener('input', () => { if (el.id !== 'startAt') { markCustom(); compute(); } });
      el.addEventListener('change', () => { markCustom(); compute(); });
    });
    $('segments').addEventListener('input', () => { markCustom(); compute(); });
    $('segments').addEventListener('change', () => { markCustom(); compute(); });
    $('startAt').addEventListener('change', () => { markCustom(); compute(); });
    $('btnAddSeg').addEventListener('click', () => {
      const cfg = C.normCfg(readCfg());
      if (cfg.segments.length >= C.LIMITS.SEG_MAX) return toast('最多 ' + C.LIMITS.SEG_MAX + ' 段');
      cfg.segments.push({ label: '新的一段', hours: 0.5, people: 1, act: 'sit', open: 0 });
      markCustom(); fillCfg(cfg); compute();
    });
    $('btnDelSeg').addEventListener('click', () => {
      const cfg = C.normCfg(readCfg());
      if (cfg.segments.length <= 1) return toast('至少要留一段');
      cfg.segments.pop();
      markCustom(); fillCfg(cfg); compute();
    });
    $('btnFill24').addEventListener('click', () => {
      const cfg = C.normCfg(readCfg());
      const segs = cfg.segments;
      const tot = segs.reduce((a, s) => a + (isFinite(s.hours) ? s.hours : 0), 0);
      const gap0 = 24 - tot;
      if (Math.abs(gap0) < 1e-6) return toast('合计已经正好 24.00 h');
      // 从最后一段往前分摊，每段最多加到 24 h / 最多减到 0.05 h
      let gap = gap0, touched = 0;
      for (let i = segs.length - 1; i >= 0 && Math.abs(gap) > 1e-9; i--) {
        const h = isFinite(segs[i].hours) ? segs[i].hours : 0;
        if (gap > 0) {
          const room = 24 - h, take = Math.min(room, gap);
          segs[i].hours = Math.round((h + take) * 1e4) / 1e4; gap -= take;
        } else {
          const room = h - 0.05, take = Math.min(room, -gap);
          segs[i].hours = Math.round((h - take) * 1e4) / 1e4; gap += take;
        }
        touched++;
      }
      if (Math.abs(gap) > 1e-6) return toast('补不上：所有段都已经到 0.05–24 h 的边界了');
      markCustom();
      fillCfg(cfg); compute();
      toast('已把差值 ' + C.fmtFix(gap0, 2) + ' h 分摊到末尾 ' + touched + ' 段');
    });
    $('scenario').addEventListener('change', (e) => {
      const id = e.target.value;
      if (!id) return;
      fillCfg(C.scenarioCfg(id));
      compute();
      toast('已载入场景：' + (C.scenarios.filter((s) => s.id === id)[0] || {}).name);
    });
    $('btnReset').addEventListener('click', () => { $('scenario').value = ''; fillCfg(C.defaultsClone()); compute(); toast('已恢复默认'); });
    $('btnSave').addEventListener('click', () => saveLocal(false));
    $('btnLoad').addEventListener('click', () => { if (loadLocal(true)) { $('scenario').value = ''; compute(); } });
    $('importFile').addEventListener('change', (e) => { if (e.target.files && e.target.files[0]) importBackup(e.target.files[0]); e.target.value = ''; });
    $('btnCsv').addEventListener('click', () => {
      if (!state.res || !state.res.ok) return toast('先让输入通过校验');
      download('通风对账台.csv', '\uFEFF' + C.csvText(state.res), 'text/csv;charset=utf-8'); toast('CSV 已导出');
    });
    $('btnMd').addEventListener('click', () => {
      if (!state.res || !state.res.ok) return toast('先让输入通过校验');
      download('通风对账台.md', C.mdText(state.res), 'text/markdown;charset=utf-8'); toast('Markdown 已导出');
    });
    $('btnJson').addEventListener('click', () => {
      if (!state.res || !state.res.ok) return toast('先让输入通过校验');
      download('通风对账台-备份.json', C.jsonBackup(state.res), 'application/json'); toast('JSON 备份已导出');
    });
    $('btnPng').addEventListener('click', () => {
      if (!state.res || !state.res.ok) return toast('先让输入通过校验');
      pngCard(); toast('结果卡 PNG 正在生成');
    });
    $('btnPrint').addEventListener('click', () => window.print());
    $('btnViewDay').addEventListener('click', () => { state.view = 'day'; syncView(); });
    $('btnViewCycle').addEventListener('click', () => {
      if (!(state.res && state.res.ok && state.res.cyc.usable)) return toast('当前设置下不存在可用的稳定日循环：' + (state.res && state.res.ok && state.res.cyc.reason ? state.res.cyc.reason : '见结论区说明'));
      state.view = 'cycle'; syncView();
    });
    $('revBox').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-apply]');
      if (!b) return;
      applyPatch(b.getAttribute('data-apply'), Number(b.getAttribute('data-val')));
    });
  }
  function syncView() {
    const r = state.res;
    const canCycle = !!(r && r.ok && r.cyc && r.cyc.usable);
    if (state.view === 'cycle' && !canCycle) state.view = 'day';
    const on = state.view === 'cycle';
    $('btnViewDay').className = on ? '' : 'on';
    $('btnViewCycle').className = on ? 'on' : '';
    $('btnViewCycle').disabled = !canCycle;
    $('btnViewCycle').title = canCycle ? '看长期每天重复的日循环' : '当前设置下不存在可用的稳定日循环（见结论区说明）';
    $('btnViewCycle').style.opacity = canCycle ? '1' : '.5';
    if (state.res && state.res.ok) {
      renderAll(state.res);
      const note = $('segTable').closest('.card').querySelector('h2');
      note.innerHTML = '逐段账 <span class="tag gray">' + (on ? '稳定日循环' : '第一天') + '</span>';
    }
  }

  /* ── 启动 ───────────────────────────────────────── */
  function boot() {
    $('scenario').innerHTML = '<option value="">— 自己填 —</option>' +
      C.scenarios.map((s) => '<option value="' + s.id + '">' + esc(s.name) + '</option>').join('');
    let cfg = null;
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) cfg = JSON.parse(raw);
    } catch (e) { cfg = null; }
    fillCfg(cfg || C.defaultsClone());
    syncView();
    bind();
    compute();
    /* 验收用的只读/半只读钩子：读状态、按真实事件改输入。 */
    window.__vl = {
      __v: 45,
      res: function () { return state.res; },
      cfg: function () { return C.normCfg(readCfg()); },
      view: function () { return state.view; },
      exports: function () { return state.exports; },
      renders: function () { return state.renders; },
      setField: function (id, value) {
        const el = $(id);
        if (!el) return false;
        el.value = String(value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      },
      pickScenario: function (id) {
        const el = $('scenario');
        el.value = id;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      },
      setSeg: function (i, key, value) {
        const el = $('s-' + key + '-' + i);
        if (!el) return false;
        el.value = String(value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      },
      viewMode: function (v) { state.view = v; syncView(); return state.view; }
    };
    window.__ventReady = true;
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
