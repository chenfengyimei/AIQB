(function(){
'use strict';

// ================= 基础工具 =================
function $(id){ return document.getElementById(id); }
function esc(s){
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function applyAdminBrand(cfg){
  var b = cfg && cfg.branding || {}, name = b.name || 'AI圈报', alias = b.alias || 'AIQB', src = b.logoUrl || '/favicon.svg';
  document.title = name + '管理后台';
  if ($('admin-favicon')) $('admin-favicon').href = b.faviconUrl || '/favicon.ico';
  if ($('admin-login-title')) $('admin-login-title').textContent = name + '管理后台';
  if ($('admin-sidebar-title')) $('admin-sidebar-title').textContent = name + '后台';
  [$('admin-login-logo'), $('admin-sidebar-logo')].forEach(function(node){
    if (!node) return; node.textContent = alias.slice(0, 2).toUpperCase();
    var img = document.createElement('img'); img.alt = ''; img.src = src; img.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:inherit;display:block';
    img.addEventListener('load', function(){ node.textContent = ''; node.appendChild(img); });
  });
}
function fmtBytes(n){
  if (!n && n !== 0) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n/1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n/1048576).toFixed(2) + ' MB';
  return (n/1073741824).toFixed(2) + ' GB';
}
function fmtNum(n){ return (n == null || isNaN(n)) ? '—' : Number(n).toLocaleString('zh-CN'); }
function fmtTime(iso){
  if (!iso) return '—';
  var d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  var p = function(n){ return String(n).padStart(2,'0'); };
  return d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}
function fmtDur(sec){
  sec = Number(sec) || 0;
  if (sec < 60) return sec + ' 秒';
  if (sec < 3600) return Math.floor(sec/60) + ' 分 ' + (sec%60) + ' 秒';
  var h = Math.floor(sec/3600), m = Math.floor((sec%3600)/60);
  return h + ' 小时' + (m ? ' ' + m + ' 分' : '');
}
function fmtMs(ms){ return ms == null ? '—' : (ms >= 1000 ? (ms/1000).toFixed(1) + ' s' : ms + ' ms'); }
function fmtDateShort(iso){
  if (!iso) return '—';
  var d = new Date(iso);
  var p = function(n){ return String(n).padStart(2,'0'); };
  return (d.getMonth()+1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

// ================= API 层 =================
var onUnauthorized = null;
var viewRequestControllers = new Set();
function abortViewRequests(){
  viewRequestControllers.forEach(function(controller){ controller.__viewAbort = true; controller.abort(); });
  viewRequestControllers.clear();
}
function setConnection(state){
  var chip = $('topbar-sync');
  if (!chip) return;
  chip.className = 'sync-chip' + (state === null ? ' loading' : state === false ? ' err' : '');
  var label = chip.querySelector('span:last-child');
  if (label) label.textContent = state === null ? '正在更新' : state === false ? '连接异常' : '连接正常';
}
function api(method, path, body){
  var opts = { method: method, headers: { 'Accept': 'application/json' }, credentials: 'same-origin' };
  var controller = typeof AbortController === 'function' ? new AbortController() : null;
  var timeoutId = controller ? setTimeout(function(){ controller.abort(); }, 15000) : null;
  if (controller) opts.signal = controller.signal;
  if (controller && method === 'GET' && path.indexOf('/api/admin/') === 0) viewRequestControllers.add(controller);
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  return fetch(path, opts).then(function(r){
    return r.json().catch(function(){ return {}; }).then(function(j){
      setConnection(true);
      if (r.status === 401) {
        if (onUnauthorized) onUnauthorized();
        throw { status: 401, error: j.error || 'unauthorized', message: j.message || '未登录或会话已过期' };
      }
      if (!r.ok) throw { status: r.status, error: j.error || 'error', message: j.message || ('HTTP ' + r.status) };
      return j;
    });
  }).catch(function(err){
    if (err && err.status) throw err;
    setConnection(false);
    if (err && err.name === 'AbortError' && controller && controller.__viewAbort) throw { status: 401, error: 'cancelled', message: '页面已切换' };
    if (err && err.name === 'AbortError') throw { status: 0, error: 'timeout', message: '请求超时，请检查服务器状态后重试' };
    throw { status: 0, error: 'network_error', message: '无法连接服务器，请稍后重试' };
  }).finally(function(){
    if (timeoutId) clearTimeout(timeoutId);
    if (controller) viewRequestControllers.delete(controller);
  });
}
function apiGet(path){ return api('GET', path); }
function apiPost(path, body){ return api('POST', path, body || {}); }
function apiPatch(path, body){ return api('PATCH', path, body || {}); }
function apiDelete(path){ return api('DELETE', path); }

// ================= Toast =================
function toast(msg, type){
  var box = $('toast-box');
  var t = document.createElement('div');
  t.className = 'toast' + (type === 'err' ? ' err' : type === 'info' ? ' info' : '');
  t.textContent = msg;
  box.appendChild(t);
  setTimeout(function(){ t.style.opacity = '0'; t.style.transition = 'opacity .3s'; }, 2600);
  setTimeout(function(){ if (t.parentNode) t.parentNode.removeChild(t); }, 3000);
}

// ================= 主题 =================
var themePref = 'auto';
try { themePref = localStorage.getItem('aiqb-theme') || 'auto'; } catch (e) {}
function applyTheme(){
  var dark = themePref === 'dark' || (themePref === 'auto' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  var mt = $('meta-theme');
  if (mt) mt.setAttribute('content', dark ? '#0b1020' : '#0b5cff');
  var b = $('btn-theme');
  if (b) { b.textContent = dark ? '☀' : '☾'; b.title = dark ? '切换到浅色模式' : '切换到深色模式'; }
}
document.addEventListener('DOMContentLoaded', function(){
  $('btn-theme').addEventListener('click', function(){
    var dark = document.documentElement.getAttribute('data-theme') === 'dark';
    themePref = dark ? 'light' : 'dark';
    try { localStorage.setItem('aiqb-theme', themePref); } catch (e) {}
    applyTheme();
  });
});
applyTheme();

// ================= SVG 图表 =================
// 折线/面积图：series=[{name,color,values[]}], labels=[]
function lineChart(series, labels, opts){
  opts = opts || {};
  var W = opts.width || 860, H = opts.height || 240;
  var padL = 44, padR = 12, padT = 14, padB = 26;
  var iw = W - padL - padR, ih = H - padT - padB;
  var n = labels.length;
  if (!n || !series.length) return '<div class="empty-tip">暂无数据</div>';
  var max = 0;
  series.forEach(function(s){ s.values.forEach(function(v){ if (v > max) max = v; }); });
  if (max <= 0) max = 1;
  // 美观刻度（1/2/5 × 10^k）
  var pow = Math.pow(10, Math.floor(Math.log(max) / Math.LN10));
  var cands = [1, 2, 5, 10];
  var step = pow;
  for (var ci = 0; ci < cands.length; ci++) {
    if (cands[ci] * pow >= max / 4) { step = cands[ci] * pow; break; }
  }
  var top = Math.ceil(max / step) * step;
  var x = function(i){ return padL + (n === 1 ? iw / 2 : (iw * i / (n - 1))); };
  var y = function(v){ return padT + ih - ih * (v / top); };
  var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto;display:block" role="img">';
  // 网格与 Y 轴刻度
  var ticks = Math.min(4, Math.max(2, Math.round(top / step)));
  for (var tI = 0; tI <= ticks; tI++) {
    var val = top * tI / ticks;
    var yy = y(val);
    svg += '<line x1="' + padL + '" y1="' + yy.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + yy.toFixed(1) + '" stroke="var(--border)" stroke-width="1"/>';
    svg += '<text x="' + (padL - 6) + '" y="' + (yy + 3.5).toFixed(1) + '" text-anchor="end" font-size="10" fill="var(--text-3)">' + fmtNum(Math.round(val)) + '</text>';
  }
  // X 轴标签（自动抽稀）
  var everyN = Math.ceil(n / Math.max(2, Math.floor(iw / 64)));
  for (var i = 0; i < n; i++) {
    if (i % everyN !== 0 && i !== n - 1) continue;
    svg += '<text x="' + x(i).toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle" font-size="10" fill="var(--text-3)">' + esc(labels[i]) + '</text>';
  }
  // 序列
  series.forEach(function(s){
    var pts = s.values.map(function(v, i){ return x(i).toFixed(1) + ',' + y(v).toFixed(1); }).join(' ');
    if (opts.area) {
      var area = padL + ',' + (padT + ih) + ' ' + pts + ' ' + (padL + iw) + ',' + (padT + ih);
      svg += '<polygon points="' + area + '" fill="' + s.color + '" opacity="0.08"/>';
    }
    svg += '<polyline points="' + pts + '" fill="none" stroke="' + s.color + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';
    if (n <= 40) {
      s.values.forEach(function(v, i){
        svg += '<circle cx="' + x(i).toFixed(1) + '" cy="' + y(v).toFixed(1) + '" r="2.6" fill="var(--surface)" stroke="' + s.color + '" stroke-width="1.6"><title>' + esc(s.name) + ' · ' + esc(labels[i]) + ' : ' + fmtNum(v) + '</title></circle>';
      });
    }
  });
  // 为每个日期覆盖透明命中区；无论数据点多少，悬停都能看到当天全部序列的精确值。
  for (var hitI = 0; hitI < n; hitI++) {
    var hitLeft = hitI === 0 ? padL : (x(hitI - 1) + x(hitI)) / 2;
    var hitRight = hitI === n - 1 ? padL + iw : (x(hitI) + x(hitI + 1)) / 2;
    var hitPayload = { label: labels[hitI], values: series.map(function(s){ return { name:s.name, color:s.color, value:Number(s.values[hitI]) || 0 }; }) };
    var nativeTitle = hitPayload.values.map(function(v){ return v.name + '：' + fmtNum(v.value); }).join(' · ');
    svg += '<rect class="chart-hit" x="' + hitLeft.toFixed(1) + '" y="' + padT + '" width="' + Math.max(1, hitRight - hitLeft).toFixed(1) + '" height="' + ih + '" fill="transparent" data-chart-tip="' + encodeURIComponent(JSON.stringify(hitPayload)) + '"><title>' + esc(labels[hitI]) + ' · ' + esc(nativeTitle) + '</title></rect>';
  }
  svg += '</svg>';
  var legend = '<div class="chart-legend">' + series.map(function(s){
    return '<span><i style="background:' + s.color + '"></i>' + esc(s.name) + '</span>';
  }).join('') + '</div>';
  return '<div class="chart-box">' + svg + legend + '</div>';
}

// 全局委托绑定，动态切换统计范围后无需重复注册事件。
(function(){
  var tooltip = null;
  function hide(){ if (tooltip) tooltip.classList.remove('show'); }
  document.addEventListener('pointermove', function(event){
    var hit = event.target && event.target.closest ? event.target.closest('.chart-hit') : null;
    if (!hit) { hide(); return; }
    var payload;
    try { payload = JSON.parse(decodeURIComponent(hit.getAttribute('data-chart-tip') || '')); } catch (e) { hide(); return; }
    if (!tooltip) { tooltip = document.createElement('div'); tooltip.className = 'chart-tooltip'; document.body.appendChild(tooltip); }
    tooltip.innerHTML = '<b>' + esc(payload.label) + '</b>' + (payload.values || []).map(function(item){ return '<span><em><i style="background:' + esc(item.color) + '"></i>' + esc(item.name) + '</em><strong>' + fmtNum(item.value) + '</strong></span>'; }).join('');
    tooltip.classList.add('show');
    var left = event.clientX + 14, top = event.clientY + 14;
    var rect = tooltip.getBoundingClientRect();
    if (left + rect.width > window.innerWidth - 8) left = event.clientX - rect.width - 14;
    if (top + rect.height > window.innerHeight - 8) top = event.clientY - rect.height - 14;
    tooltip.style.left = Math.max(8, left) + 'px'; tooltip.style.top = Math.max(8, top) + 'px';
  });
  document.addEventListener('pointerleave', hide);
})();

// 柱状图：data=[{label,value,color?}]
function barChart(data, opts){
  opts = opts || {};
  var W = opts.width || 860, H = opts.height || 200;
  var padL = 40, padR = 8, padT = 12, padB = 26;
  var iw = W - padL - padR, ih = H - padT - padB;
  var n = data.length;
  if (!n) return '<div class="empty-tip">暂无数据</div>';
  var max = 0;
  data.forEach(function(d){ if (d.value > max) max = d.value; });
  if (max <= 0) max = 1;
  var pow = Math.pow(10, Math.floor(Math.log(max) / Math.LN10));
  var cands = [1, 2, 5, 10];
  var step = pow;
  for (var si = 0; si < cands.length; si++) {
    if (cands[si] * pow >= max / 3) { step = cands[si] * pow; break; }
  }
  var top = Math.ceil(max / step) * step;
  var y = function(v){ return padT + ih - ih * (v / top); };
  var bw = Math.min(38, iw / n * 0.62);
  var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto;display:block" role="img">';
  var ticks = Math.min(4, Math.max(2, Math.round(top / step)));
  for (var tI = 0; tI <= ticks; tI++) {
    var val = top * tI / ticks;
    var yy = y(val);
    svg += '<line x1="' + padL + '" y1="' + yy.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + yy.toFixed(1) + '" stroke="var(--border)" stroke-width="1"/>';
    svg += '<text x="' + (padL - 6) + '" y="' + (yy + 3.5).toFixed(1) + '" text-anchor="end" font-size="10" fill="var(--text-3)">' + fmtNum(Math.round(val)) + '</text>';
  }
  var everyN = Math.ceil(n / Math.max(2, Math.floor(iw / 56)));
  data.forEach(function(d, i){
    var cx = padL + iw * (i + 0.5) / n;
    var bx = cx - bw / 2;
    var by = y(d.value);
    svg += '<rect x="' + bx.toFixed(1) + '" y="' + by.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + (padT + ih - by).toFixed(1) + '" rx="3" fill="' + (d.color || 'var(--brand)') + '" opacity="0.85"><title>' + esc(d.label) + ' : ' + fmtNum(d.value) + '</title></rect>';
    if (i % everyN === 0 || i === n - 1) {
      svg += '<text x="' + cx.toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle" font-size="10" fill="var(--text-3)">' + esc(d.label) + '</text>';
    }
  });
  svg += '</svg>';
  return '<div class="chart-box">' + svg + '</div>';
}
// ================= 应用状态与路由 =================
var App = { user: null, view: 'overview', overviewTimer: null, healthTimer: null, healthLoading: false, keepaliveTimer: null, lastViewRefreshAt: 0 };
var VIEW_TITLES = {
  overview: '数据概览', health: '健康管理', visits: '访问统计', intelligence: '情报管理', endpoints: '接口管理', email: '邮箱管理', seo: 'SEO 管理', friendLinks: '友链管理', snapshots: '数据快照', logs: '采集日志', settings: '系统设置', update: '在线更新', about: '关于系统'
};

function showLogin(msg){
  abortViewRequests();
  if (App.overviewTimer) { clearInterval(App.overviewTimer); App.overviewTimer = null; }
  if (App.healthTimer) { clearInterval(App.healthTimer); App.healthTimer = null; }
  if (App.keepaliveTimer) { clearInterval(App.keepaliveTimer); App.keepaliveTimer = null; }
  $('app-view').style.display = 'none';
  $('login-view').style.display = 'flex';
  $('login-pass').type = 'password';
  $('login-pass-toggle').textContent = '显示';
  $('login-pass-toggle').setAttribute('aria-label', '显示密码');
  var err = $('login-err');
  if (msg) { err.textContent = msg; err.classList.add('show'); }
  else err.classList.remove('show');
  setTimeout(function(){ $('login-user').focus(); }, 50);
}

function showApp(){
  $('login-view').style.display = 'none';
  $('app-view').style.display = 'block';
  $('topbar-user').textContent = App.user ? App.user.username : '—';
  // 会话保活（服务端滑动续期）
  if (!App.keepaliveTimer) {
    App.keepaliveTimer = setInterval(function(){ apiGet('/api/admin/me').catch(function(){}); }, 5 * 60 * 1000);
  }
  switchView(App.view, true);
}

function switchView(view, force){
  if (App.view === view && !force) return;
  abortViewRequests();
  App.view = view;
  App.lastViewRefreshAt = Date.now();
  if (view !== 'endpoints') endpointActiveId = null;
  if (view !== 'friendLinks') friendEditingId = null;
  document.querySelectorAll('.nav-item').forEach(function(b){
    b.classList.toggle('on', b.getAttribute('data-view') === view);
  });
  $('view-title').textContent = VIEW_TITLES[view] || view;
  if (App.overviewTimer) { clearInterval(App.overviewTimer); App.overviewTimer = null; }
  if (App.healthTimer) { clearInterval(App.healthTimer); App.healthTimer = null; }
  App.healthLoading = false;
  var render = VIEWS[view];
  if (render) { setConnection(null); render($('view')); }
}

function loadViewSpinner(el){
  // 首次进入才显示整页骨架；刷新时保留已有内容，顶部连接状态提示正在更新。
  if (!el.firstElementChild) el.innerHTML = '<div class="loading-tip"><div class="spin"></div><div>加载中…</div></div>';
}

// ================= 视图：数据概览 =================
function viewOverview(el){
  loadViewSpinner(el);
  apiGet('/api/admin/dashboard').then(function(bundle){
    var ov = bundle.overview, st = bundle.stats, roll = bundle.rollup, snaps = bundle.snapshots, intelTrend = bundle.intelligenceTrend;
    var today = st.today, totals = st.totals;
    var frontToday = today.scopes && today.scopes.frontend || today;
    var adminToday = today.scopes && today.scopes.admin || {pv:0,requests:0};
    var intel = ov.intelligence || {};
    var last = ov.collect && ov.collect.last;
    var errBanner = '';
    if (last && !last.ok) {
      errBanner = '<div class="banner warn"><span>⚠</span><div><b>最近一次采集失败</b>（' + esc(fmtTime(last.at)) + '）：' + esc(last.error || '未知错误') +
        '<br/>已自动保留旧数据继续提供服务，稍后将自动重试；也可在「数据快照」页手动采集。</div></div>';
    }
    var latest = ov.latest;
    el.innerHTML = '' +
      errBanner +
      '<div class="kpi-grid">' +
        kpi('今日前台 PV', fmtNum(frontToday.pv), '总页面 ' + fmtNum(today.pv) + ' PV') +
        kpi('今日前台 UV', fmtNum(frontToday.uv), '仅公开看板访客', 'teal') +
        kpi('今日前台 IP', fmtNum(frontToday.ips), '仅公开看板独立 IP', 'teal') +
        kpi('今日其他访问', fmtNum((today.hits || 0) - (frontToday.requests || 0)), '后台 ' + fmtNum(adminToday.requests) + ' · API/资源等') +
      '</div>' +
      '<div class="kpi-grid">' +
        kpi('最新快照', latest ? fmtNum(latest.counts.w7) + '<small> 条 7d</small>' : '—', latest ? esc(fmtTime(latest.fetchedAt)) : '尚无数据') +
        kpi('历史快照', fmtNum(ov.store.entries) + '<small> 份</small>', fmtBytes(ov.store.bytes) + ' · 失败 ' + ov.store.failEntries + ' 次') +
        kpi('下次自动采集', ov.collect.nextCollectAt ? countdownHtml(ov.collect.nextCollectAt) : '—', '间隔 ' + ov.collect.intervalHours + ' 小时') +
        kpi('服务运行', fmtDur(ov.uptimeSec), '内存 ' + ov.memoryMB.rss + ' MB · Node ' + esc(String(ov.nodeVersion).replace('v',''))) +
      '</div>' +
      '<div class="kpi-grid">' +
        kpi('情报库总量', fmtNum(intel.active) + '<small> 条</small>', '已发布 ' + fmtNum(intel.published) + ' · 草稿 ' + fmtNum(intel.draft)) +
        kpi('今日新增', fmtNum(intel.newToday) + '<small> 条</small>', '今日更新 ' + fmtNum(intel.updatedToday) + ' 条', 'teal') +
        kpi('累计避免重复', fmtNum(intel.duplicatesPrevented) + '<small> 条</small>', '采集核实后合并复用', 'good') +
        kpi('独立信源', fmtNum(intel.uniqueSources) + '<small> 个</small>', '情报库 ' + fmtBytes(intel.storageBytes)) +
      '</div>' +
      '<div class="card"><h3><span class="bar"></span>近 14 天访问趋势<span class="right">PV / UV / 独立 IP</span></h3>' +
        lineChart([
          { name: '前台 PV', color: '#0b5cff', values: st.days.map(function(d){ return d.scopes && d.scopes.frontend ? d.scopes.frontend.pv : d.pv; }) },
          { name: '前台 UV', color: '#0f9b8e', values: st.days.map(function(d){ return d.scopes && d.scopes.frontend ? d.scopes.frontend.uv : d.uv; }) },
          { name: '前台 IP', color: '#e35d2b', values: st.days.map(function(d){ return d.scopes && d.scopes.frontend ? d.scopes.frontend.ips : d.ips; }) },
        ], st.days.map(function(d){ return d.date.slice(5); }), { area: true }) +
      '</div>' +
      '<div class="card"><h3><span class="bar"></span>近 14 天情报数据曲线<span class="right">库存 / 新增 / 去重</span></h3>' +
        lineChart([
          { name: '情报库存', color: '#0b5cff', values: intelTrend.days.map(function(d){ return d.total; }) },
          { name: '新增情报', color: '#16a34a', values: intelTrend.days.map(function(d){ return d.added; }) },
          { name: '避免重复', color: '#e35d2b', values: intelTrend.days.map(function(d){ return d.duplicates; }) },
        ], intelTrend.days.map(function(d){ return d.date.slice(5); }), { area: true }) +
      '</div>' +
      '<div class="card"><h3><span class="bar"></span>近 14 天采集窗口<span class="right">7 天窗条目合计</span></h3>' +
        barChart(roll.days.map(function(d){ return { label: d.date.slice(5), value: d.w7 }; })) +
      '</div>' +
      '<div class="card"><h3><span class="bar"></span>最近采集记录<span class="right"><button class="btn sm" id="ov-refresh">刷新</button></span></h3>' +
        snapshotTable(snaps, true) +
      '</div>';
    bindCountdown(el);
    $('ov-refresh').addEventListener('click', function(){ viewOverview(el); });
    if (App.overviewTimer) clearInterval(App.overviewTimer);
    App.overviewTimer = setInterval(function(){ viewOverview(el); }, 60 * 1000);
  }).catch(function(err){
    if (err.status !== 401) {
      el.innerHTML = '<div class="banner warn"><span>⚠</span><div>加载失败：' + esc(err.message || err.error || '未知错误') + '</div></div>';
    }
  });
}

function kpi(label, num, sub, cls){
  return '<div class="kpi' + (cls ? ' ' + cls : '') + '"><div class="label">' + esc(label) + '</div><div class="num">' + num + '</div><div class="sub">' + sub + '</div></div>';
}

// ================= 视图：健康管理 =================
function healthStatusText(status){
  return status === 'healthy' ? '运行正常' : status === 'warning' ? '需要关注' : status === 'critical' ? '存在异常' : '等待采样';
}
function healthLevel(value, warningAt, criticalAt){
  value = Number(value);
  if (!isFinite(value)) return 'unknown';
  return value >= criticalAt ? 'critical' : value >= warningAt ? 'warning' : 'healthy';
}
function healthMeter(label, value, detail, warningAt, criticalAt){
  var num = Number(value), level = healthLevel(value, warningAt, criticalAt);
  var width = isFinite(num) ? Math.max(0, Math.min(100, num)) : 0;
  return '<div class="health-meter"><div class="health-meter-head"><b>' + esc(label) + '</b><span>' + esc(detail) + '</span></div>' +
    '<div class="health-track"><div class="health-fill ' + level + '" style="width:' + width + '%"></div></div></div>';
}
function healthFact(label, value, title){
  return '<div class="health-fact"><span>' + esc(label) + '</span><b' + (title ? ' title="' + esc(title) + '"' : '') + '>' + esc(value) + '</b></div>';
}
function viewHealth(el, quiet){
  if (App.healthLoading) return;
  App.healthLoading = true;
  if (!quiet) loadViewSpinner(el);
  apiGet('/api/admin/health').then(function(h){
    if (App.view !== 'health') return;
    var host = h.host || {}, cpu = host.cpu || {}, mem = host.memory || {}, disk = host.disk;
    var proc = h.process || {}, response = h.response || {}, recent = response.recent || {}, hour = response.hour || {};
    var performanceInfo = h.performance || {}, cacheInfo = performanceInfo.caches || {}, historyCache = cacheInfo.history || {}, documentCache = cacheInfo.documents || {}, databaseInfo = performanceInfo.database || {};
    var data = h.data || {}, endpoint = data.endpoints || {}, collect = data.collect || {};
    var overall = h.overall || 'unknown';
    var icon = overall === 'healthy' ? '✓' : overall === 'warning' ? '!' : overall === 'critical' ? '×' : '…';
    var processHeapPercent = proc.heapTotal ? Math.round(proc.heapUsed / proc.heapTotal * 1000) / 10 : 0;
    var checkRows = (h.checks || []).map(function(item){
      return '<div class="health-check ' + esc(item.status || 'unknown') + '"><i class="health-dot"></i><div><b>' + esc(item.label) + '</b><span>' + esc(item.message) + '</span></div></div>';
    }).join('');
    var scopeNames = { frontend:'前台页面', admin_page:'后台页面', admin_api:'后台 API', public_api:'公开 API', asset:'静态资源', other:'其他请求' };
    var scopeRows = Object.keys(recent.byScope || {}).sort(function(a,b){ return recent.byScope[b].count - recent.byScope[a].count; }).map(function(key){
      var row = recent.byScope[key];
      return '<tr><td>' + esc(scopeNames[key] || key) + '</td><td class="num-c">' + fmtNum(row.count) + '</td><td class="num-c">' + fmtMs(row.avgMs) + '</td><td class="num-c">' + fmtMs(row.maxMs) + '</td><td class="num-c">' + esc(row.errorRate + '%') + '</td></tr>';
    }).join('');
    var pathRows = (response.topPaths || []).map(function(row){
      return '<tr><td class="mono">' + esc(row.path) + '</td><td class="num-c">' + fmtNum(row.count) + '</td><td class="num-c">' + fmtMs(row.avgMs) + '</td><td class="num-c">' + fmtMs(row.maxMs) + '</td><td class="num-c">' + fmtNum(row.errors) + '</td></tr>';
    }).join('');
    var latestText = data.ageSec == null ? '尚无数据' : fmtDur(data.ageSec) + '前';
    var lastCollect = collect.last || null;

    el.innerHTML = '' +
      '<div class="health-banner ' + esc(overall) + '"><div class="health-orb">' + icon + '</div><div class="health-main"><b>服务器' + healthStatusText(overall) + '</b><small>实时采样于 ' + esc(fmtTime(h.generatedAt)) + '，每 15 秒自动刷新；黄色或红色项目建议优先检查。</small></div><button class="btn sm" id="health-refresh">立即刷新</button></div>' +
      '<div class="kpi-grid">' +
        kpi('服务状态', healthStatusText(overall), 'AIQB v' + esc(proc.version || '—'), overall === 'healthy' ? 'good' : 'warn') +
        kpi('CPU 使用率', cpu.percent == null ? '采样中' : esc(cpu.percent + '%'), esc(cpu.cores + ' 核 · 负载 ' + Number(cpu.load1 || 0).toFixed(2)), healthLevel(cpu.percent,75,92) === 'healthy' ? 'teal' : 'warn') +
        kpi('系统内存', esc(mem.percent + '%'), fmtBytes(mem.used) + ' / ' + fmtBytes(mem.total), healthLevel(mem.percent,82,94) === 'healthy' ? 'teal' : 'warn') +
        kpi('近 15 分钟 P95', fmtMs(recent.p95Ms), fmtNum(recent.count) + ' 请求 · 错误率 ' + esc((recent.errorRate || 0) + '%'), healthLevel(recent.p95Ms,1200,4000) === 'healthy' ? 'good' : 'warn') +
      '</div>' +
      '<div class="health-grid">' +
        '<div class="card"><h3><span class="bar"></span>服务器资源<span class="right">系统运行 ' + esc(fmtDur(host.uptimeSec)) + '</span></h3>' +
          healthMeter('CPU', cpu.percent, cpu.percent == null ? '等待第二次采样' : cpu.percent + '%', 75, 92) +
          healthMeter('1 分钟负载 / 核心', cpu.loadPercent, (cpu.load1 || 0).toFixed(2) + ' / ' + cpu.cores + ' 核', 80, 110) +
          healthMeter('系统内存', mem.percent, fmtBytes(mem.free) + ' 可用', 82, 94) +
          healthMeter('数据盘', disk && disk.percent, disk ? fmtBytes(disk.free) + ' 可用' : '无法读取', 82, 94) +
          '<div class="health-facts">' + healthFact('主机', host.hostname || '—') + healthFact('平台', (host.platform || '—') + ' / ' + (host.arch || '—')) + healthFact('CPU 型号', cpu.model || '—', cpu.model || '') + healthFact('15 分钟负载', Number(cpu.load15 || 0).toFixed(2)) + '</div>' +
        '</div>' +
        '<div class="card"><h3><span class="bar"></span>Node 服务进程<span class="right">PID ' + esc(proc.pid) + '</span></h3>' +
          healthMeter('Heap 使用', processHeapPercent, fmtBytes(proc.heapUsed) + ' / ' + fmtBytes(proc.heapTotal), 80, 95) +
          '<div class="health-facts">' +
            healthFact('进程运行', fmtDur(proc.uptimeSec)) + healthFact('Node.js', proc.nodeVersion || '—') +
            healthFact('进程 RSS', fmtBytes(proc.rss)) + healthFact('外部内存', fmtBytes(proc.external)) +
            healthFact('事件循环延迟', fmtMs(proc.eventLoopLagMs)) + healthFact('处理中请求', fmtNum(proc.inFlight)) +
          '</div>' +
          '<div class="hint" style="margin-top:10px">服务启动时间：' + esc(fmtTime(proc.startedAt)) + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="health-grid">' +
        '<div class="card"><h3><span class="bar"></span>健康检查<span class="right">' + fmtNum((h.checks || []).length) + ' 项</span></h3>' + (checkRows || '<div class="empty-tip">暂无检查项</div>') + '</div>' +
        '<div class="card"><h3><span class="bar"></span>数据与采集<span class="right">最新数据 ' + esc(latestText) + '</span></h3><div class="health-facts">' +
          healthFact('情报库存', fmtNum(data.intelligence && data.intelligence.active)) + healthFact('历史快照', fmtNum(data.snapshots && data.snapshots.entries)) +
          healthFact('接口健康', fmtNum(endpoint.healthy) + ' / ' + fmtNum(endpoint.enabled)) + healthFact('接口异常', fmtNum(endpoint.error)) +
          healthFact('采集状态', collect.busy ? '正在采集' : '空闲') + healthFact('采集周期', fmtNum(collect.intervalHours) + ' 小时') +
          healthFact('最近采集', lastCollect ? (lastCollect.ok ? '成功' : '失败') : '暂无记录') + healthFact('最近耗时', lastCollect ? fmtMs(lastCollect.durationMs) : '—') +
          '</div><div class="hint" style="margin-top:10px">最近更新：' + esc(fmtTime(data.latestAt)) + ' · 下次采集：' + esc(fmtTime(collect.nextCollectAt)) + '</div></div>' +
      '</div>' +
      '<div class="card"><h3><span class="bar"></span>响应速度<span class="right">滚动内存样本，不增加磁盘写入</span></h3>' +
        '<div class="kpi-grid">' +
          kpi('15 分钟平均', fmtMs(recent.avgMs), 'P50 ' + fmtMs(recent.p50Ms)) +
          kpi('15 分钟 P95', fmtMs(recent.p95Ms), 'P99 ' + fmtMs(recent.p99Ms), 'teal') +
          kpi('15 分钟最大', fmtMs(recent.maxMs), fmtNum(recent.count) + ' 个样本', recent.maxMs >= 4000 ? 'warn' : '') +
          kpi('近 1 小时请求', fmtNum(hour.count), '平均 ' + fmtMs(hour.avgMs) + ' · ' + fmtNum(hour.errors) + ' 次 5xx') +
        '</div><div class="tbl-wrap"><table class="tbl"><thead><tr><th>请求类型</th><th class="num-c">数量</th><th class="num-c">平均</th><th class="num-c">最大</th><th class="num-c">5xx 率</th></tr></thead><tbody>' + (scopeRows || '<tr><td colspan="5"><div class="empty-tip">等待产生请求样本</div></td></tr>') + '</tbody></table></div></div>' +
      '<div class="card"><h3><span class="bar"></span>响应缓存<span class="right">数据版本 ' + esc(performanceInfo.dataRevision || '—') + '</span></h3><div class="health-facts">' +
        healthFact('历史查询缓存', fmtNum(historyCache.entries) + ' 项') + healthFact('历史命中 / 未命中', fmtNum(historyCache.hits) + ' / ' + fmtNum(historyCache.misses)) +
        healthFact('文章页面缓存', fmtNum(documentCache.entries) + ' 项') + healthFact('文章命中 / 未命中', fmtNum(documentCache.hits) + ' / ' + fmtNum(documentCache.misses)) +
        healthFact('缓存占用', fmtBytes((historyCache.bytes || 0) + (documentCache.bytes || 0))) + healthFact('真实体验样本', fmtNum(performanceInfo.webVitals && performanceInfo.webVitals.samples)) +
        healthFact('SQLite 状态', databaseInfo.enabled ? 'WAL 正常' : '未启用') + healthFact('SQLite 大小 / 写等待', fmtBytes(databaseInfo.bytes || 0) + ' / ' + fmtMs(databaseInfo.lastWriteMs || 0)) +
      '</div></div>' +
      '<div class="card"><h3><span class="bar"></span>慢请求路径<span class="right">按服务启动以来平均耗时排序</span></h3><div class="tbl-wrap"><table class="tbl"><thead><tr><th>路径</th><th class="num-c">请求</th><th class="num-c">平均</th><th class="num-c">最大</th><th class="num-c">5xx</th></tr></thead><tbody>' + (pathRows || '<tr><td colspan="5"><div class="empty-tip">等待产生请求样本</div></td></tr>') + '</tbody></table></div></div>';
    $('health-refresh').addEventListener('click', function(){ viewHealth(el, true); });
    if (!App.healthTimer) App.healthTimer = setInterval(function(){ if (App.view === 'health') viewHealth(el, true); }, 15000);
  }).catch(function(err){
    if (err.status !== 401 && App.view === 'health') {
      if (quiet) toast('健康指标刷新失败：' + (err.message || '未知错误'), 'err');
      else el.innerHTML = '<div class="banner warn"><span>⚠</span><div>健康数据加载失败：' + esc(err.message || '未知错误') + '</div></div>';
    }
  }).finally(function(){ App.healthLoading = false; });
}

function countdownHtml(iso){
  return '<span class="cd" data-at="' + esc(iso) + '">—</span>';
}
function bindCountdown(scope){
  scope.querySelectorAll('.cd').forEach(function(n){
    var at = new Date(n.getAttribute('data-at')).getTime();
    if (isNaN(at)) { n.textContent = '—'; return; }
    var tick = function(){
      var left = Math.max(0, Math.floor((at - Date.now()) / 1000));
      var h = Math.floor(left / 3600), m = Math.floor((left % 3600) / 60), s = left % 60;
      var p = function(x){ return String(x).padStart(2,'0'); };
      n.textContent = p(h) + ':' + p(m) + ':' + p(s);
      if (left <= 0) { n.textContent = '即将采集'; clearInterval(iv); }
    };
    var iv = setInterval(tick, 1000);
    tick();
  });
}

function snapshotTable(res, compact){
  if (!res.items.length) return '<div class="empty-tip">还没有采集记录，等待首次采集或前往「数据快照」手动采集。</div>';
  var rows = res.items.map(function(e){
    return '<tr>' +
      '<td title="' + esc(e.fetchedAt) + '">' + esc(fmtTime(e.fetchedAt)) + '</td>' +
      '<td>' + (e.ok ? '<span class="tag ok">成功</span>' : '<span class="tag fail">失败</span>') + '</td>' +
      '<td class="num-c">' + (e.ok ? fmtNum(e.counts && e.counts.w7) : '—') + '</td>' +
      '<td class="num-c">' + (e.ok ? fmtNum(e.counts && e.counts.w24) : '—') + '</td>' +
      '<td class="num-c">' + (e.ok ? fmtNum(e.counts && e.counts.hot) : '—') + '</td>' +
      (compact ? '' : '<td>' + (e.sameAs ? '<span class="tag mut" title="内容与上一份完全相同，未重复落盘">去重复用</span>' : fmtBytes(e.bytes)) + '</td>') +
      (compact ? '' : '<td class="mono">' + (e.sha8 || '—') + '</td>') +
      '<td class="num-c">' + fmtMs(e.durationMs) + '</td>' +
      (compact ? '' : '<td><button class="btn sm" data-act="view" data-id="' + esc(e.id) + '">查看</button> <button class="btn sm danger" data-act="del" data-id="' + esc(e.id) + '">删除</button></td>') +
    '</tr>';
  }).join('');
  return '<div class="tbl-wrap"><table class="tbl"><thead><tr>' +
    '<th>采集时间</th><th>状态</th><th class="num-c">7d 条目</th><th class="num-c">24h 条目</th><th class="num-c">热点</th>' +
    (compact ? '' : '<th>大小</th><th>SHA-256</th>') +
    '<th class="num-c">耗时</th>' +
    (compact ? '' : '<th>操作</th>') +
    '</tr></thead><tbody>' + rows + '</tbody></table></div>';
}
// ================= 视图：访问统计 =================
var visitsRange = 30;
function viewVisits(el){
  loadViewSpinner(el);
  apiGet('/api/admin/stats?days=' + visitsRange).then(function(st){
    var scopeLabel = function(key){ return (st.scopeLabels && st.scopeLabels[key]) || key; };
    var todayScopes = st.today.scopes || {};
    var rangeScopes = st.rangeTotals && st.rangeTotals.scopes || {};
    var totalScopes = st.totals && st.totals.scopes || {};
    var frontToday = todayScopes.frontend || {};
    var adminToday = todayScopes.admin || {};
    var publicApiToday = todayScopes.api || {};
    var frontHistory = totalScopes.frontend || {};
    var adminHistory = totalScopes.admin || {};
    var currentMonth = st.currentMonth || {};
    var frontMonth = currentMonth.scopes && currentMonth.scopes.frontend || {};
    var months = st.months.slice().reverse();
    var monthRows = months.map(function(m){
      var fs = m.scopes && m.scopes.frontend || {}, as = m.scopes && m.scopes.admin || {}, api = m.scopes && m.scopes.api || {};
      return '<tr><td><b>' + esc(m.month) + '</b></td><td class="num-c"><b>' + fmtNum(fs.pv) + '</b></td><td class="num-c">' + fmtNum(fs.uv) + '</td><td class="num-c">' + fmtNum(fs.ips) + '</td><td class="num-c"><b>' + fmtNum(m.articlePv) + '</b></td><td class="num-c">' + fmtNum(m.articleShares) + '</td><td class="num-c">' + fmtNum(as.pv) + '</td><td class="num-c">' + fmtNum(m.clicks) + '</td><td class="num-c">' + fmtNum(api.requests) + '</td><td class="num-c">' + fmtNum(m.hits) + '</td><td class="num-c">' + m.avgPvPerDay + '</td></tr>';
    }).join('') || '<tr><td colspan="11" class="empty-tip">暂无月度数据</td></tr>';

    var topRows = st.topPages.map(function(p, i){
      return '<tr><td class="num-c">' + (i+1) + '</td><td><span class="tag ' + (p.scope === 'frontend' ? 'info' : 'mut') + '">' + esc(scopeLabel(p.scope)) + '</span></td><td class="mono">' + esc(p.path) + '</td><td class="num-c"><b>' + fmtNum(p.views) + '</b></td><td class="num-c">' + fmtNum(p.uv) + '</td><td class="num-c">' + fmtNum(p.ips) + '</td></tr>';
    }).join('') || '<tr><td colspan="6" class="empty-tip">暂无页面访问数据</td></tr>';

    var routeRows = (st.topRoutes || []).map(function(p, i){
      return '<tr><td class="num-c">' + (i+1) + '</td><td><span class="tag mut">' + esc(scopeLabel(p.scope)) + '</span></td><td class="mono">' + esc(p.path) + '</td><td class="num-c"><b>' + fmtNum(p.requests) + '</b></td><td class="num-c">' + fmtNum(p.uv) + '</td><td class="num-c">' + fmtNum(p.ips) + '</td></tr>';
    }).join('') || '<tr><td colspan="6" class="empty-tip">暂无请求路径数据</td></tr>';

    var scopeRows = ['frontend','admin','api','click','asset','other'].map(function(key){
      var x = rangeScopes[key] || {};
      return '<tr><td><span class="tag ' + (key === 'frontend' ? 'info' : key === 'click' ? 'ok' : 'mut') + '">' + esc(scopeLabel(key)) + '</span></td><td class="num-c"><b>' + fmtNum(x.pv) + '</b></td><td class="num-c">' + fmtNum(x.uv) + '</td><td class="num-c">' + fmtNum(x.ips) + '</td><td class="num-c">' + fmtNum(x.requests) + '</td><td class="num-c">' + fmtNum(x.api) + '</td></tr>';
    }).join('');

    var rangeFrontGeo = rangeScopes.frontend && rangeScopes.frontend.geography || { countries:{}, regions:{} };
    var countryDisplay = null;
    try { countryDisplay = new Intl.DisplayNames(['zh-CN'], { type:'region' }); } catch (e) {}
    var countryRows = Object.keys(rangeFrontGeo.countries || {}).map(function(key){ return rangeFrontGeo.countries[key]; }).sort(function(a,b){ return b.ips-a.ips || b.pv-a.pv; }).slice(0,20).map(function(row, i){
      var name = row.name || (countryDisplay ? countryDisplay.of(row.code) : '') || row.code;
      return '<tr><td class="num-c">' + (i+1) + '</td><td><b>' + esc(name) + '</b> <span class="tag mut">' + esc(row.code) + '</span></td><td class="num-c"><b>' + fmtNum(row.ips) + '</b></td><td class="num-c">' + fmtNum(row.pv) + '</td><td class="num-c">' + fmtNum(row.requests) + '</td></tr>';
    }).join('') || '<tr><td colspan="5" class="empty-tip">尚未收到国家字段：请在 EdgeOne 回源头中设置 EO-Client-IPCountry = ${http.request.ip.country}</td></tr>';
    var regionRows = Object.keys(rangeFrontGeo.regions || {}).map(function(key){ return rangeFrontGeo.regions[key]; }).sort(function(a,b){ return b.ips-a.ips || b.pv-a.pv; }).slice(0,30).map(function(row, i){
      var label = row.name || row.code;
      return '<tr><td class="num-c">' + (i+1) + '</td><td><b>' + esc(label) + '</b></td><td><span class="tag mut">' + esc(row.code || row.country) + '</span></td><td class="num-c"><b>' + fmtNum(row.ips) + '</b></td><td class="num-c">' + fmtNum(row.pv) + '</td><td class="num-c">' + fmtNum(row.requests) + '</td></tr>';
    }).join('') || '<tr><td colspan="6" class="empty-tip">尚未收到省份字段：设置 EO-Client-Region-Code = ${http.request.ip.region_code}，EO-Client-Region = ${http.request.ip.region_name}；城市可设置 EO-Client-City = ${http.request.ip.city}</td></tr>';

    var recentRows = st.recent.map(function(r){
      var typeTag = '<span class="tag ' + (r.scope === 'frontend' ? 'info' : r.type === 'click' ? 'ok' : 'mut') + '">' + esc(scopeLabel(r.scope)) + '</span>';
      var pathCell = r.type === 'click'
        ? '<td class="mono" title="' + esc(r.title || '') + '">' + esc(String(r.path || '').replace(/^https?:\/\//, '').slice(0, 46)) + (r.kind === 'friend' ? ' <span class="tag info">友链</span>' : r.kind === 'share' ? ' <span class="tag ok">文章分享</span>' : '') + '</td>'
        : '<td class="mono">' + esc(r.path) + '</td>';
      var geo = r.geo || {}, geoText = [geo.country, geo.region || geo.regionCode, geo.city].filter(Boolean).join(' · ') || '未获取';
      var ipText = r.ipSegment || (r.ip ? String(r.ip).slice(0, 8) + '…（历史）' : '未知');
      return '<tr><td title="' + esc(r.t) + '">' + esc(fmtTime(r.t)) + '</td><td class="mono">' + esc(ipText) + '</td><td>' + esc(geoText) + '</td>' + pathCell + '<td>' + typeTag + '</td><td class="num-c">' + r.status + '</td></tr>';
    }).join('') || '<tr><td colspan="6" class="empty-tip">今日暂无访问</td></tr>';

    var linkRows = (st.topLinks || []).map(function(l, i){
      return '<tr><td class="num-c">' + (i+1) + '</td><td class="mono" style="word-break:break-all;max-width:340px" title="' + esc(l.title || '') + '">' + esc(String(l.url || '').replace(/^https?:\/\//, '').slice(0, 48)) + '</td><td>' + (l.kind === 'friend' ? '<span class="tag info">友链</span>' : '<span class="tag mut">情报</span>') + '</td><td class="num-c">' + fmtNum(l.clicks) + '</td></tr>';
    }).join('') || '<tr><td colspan="4" class="empty-tip">暂无链接点击数据</td></tr>';

    el.innerHTML = '' +
      '<div class="toolbar-row">' +
        '<div class="seg">' +
          [[7,'7 天'],[30,'30 天'],[90,'90 天'],[365,'1 年'],[1095,'3 年'],[3650,'10 年']].map(function(x){ return '<button class="btn sm' + (visitsRange === x[0] ? ' btn-solid' : '') + '" data-days="' + x[0] + '">' + x[1] + '</button>'; }).join('') +
        '</div>' +
        '<span class="spacer"></span>' +
        '<span style="font-size:12px;color:var(--text-3)">永久保存 · 首日 ' + esc(st.firstDate) + ' · UV/IP 日内去重、跨天重新累计</span>' +
      '</div>' +
      '<section class="metric-block"><div class="metric-heading">今日前台</div><div class="kpi-grid">' +
        kpi('今日前台 PV', fmtNum(frontToday.pv), '不含后台与 API', 'good') +
        kpi('今日前台 UV', fmtNum(frontToday.uv), '公开看板独立访客', 'teal') +
        kpi('今日前台 IP', fmtNum(frontToday.ips), '公开看板独立 IP', 'teal') +
        kpi('今日前台链接 PV', fmtNum(st.today.clicks), '情报原文 ' + fmtNum(st.today.itemClicks) + ' · 友链 ' + fmtNum(st.today.friendClicks), 'good') +
      '</div></section>' +
      '<section class="metric-block"><div class="metric-heading">本月前台</div><div class="kpi-grid">' +
        kpi('本月前台 PV', fmtNum(frontMonth.pv), '本月公开页面访问', 'good') +
        kpi('本月前台 UV', fmtNum(frontMonth.uv), '每日去重后累计', 'teal') +
        kpi('本月前台 IP', fmtNum(frontMonth.ips), '每日去重后累计', 'teal') +
        kpi('本月前台链接 PV', fmtNum(currentMonth.clicks), '情报原文 ' + fmtNum(currentMonth.itemClicks) + ' · 友链 ' + fmtNum(currentMonth.friendClicks), 'good') +
      '</div></section>' +
      '<section class="metric-block"><div class="metric-heading">历史前台</div><div class="kpi-grid">' +
        kpi('历史前台 PV', fmtNum(frontHistory.pv), '全部永久历史') +
        kpi('历史前台 UV', fmtNum(frontHistory.uv), '每日去重值累计', 'teal') +
        kpi('历史前台 IP', fmtNum(frontHistory.ips), '每日去重值累计', 'teal') +
        kpi('历史链接点击', fmtNum(st.totals.clicks), '情报原文 ' + fmtNum(st.totals.itemClicks) + ' · 友链 ' + fmtNum(st.totals.friendClicks), 'good') +
      '</div></section>' +
      '<section class="metric-block"><div class="metric-heading">文章访问</div><div class="kpi-grid">' +
        kpi('今日文章 PV', fmtNum(st.today.articlePv), '仅文章详情页成功访问', 'good') +
        kpi('本月文章 PV', fmtNum(currentMonth.articlePv), '本月文章详情访问', 'teal') +
        kpi('历史文章 PV', fmtNum(st.totals.articlePv), '已有流水自动回算并永久累计', 'teal') +
        kpi('分享文章次数', fmtNum(st.totals.articleShares), '今日 ' + fmtNum(st.today.articleShares) + ' · 本月 ' + fmtNum(currentMonth.articleShares), 'good') +
      '</div></section>' +
      '<section class="metric-block"><div class="metric-heading">后台访问</div><div class="kpi-grid">' +
        kpi('今日后台 PV', fmtNum(adminToday.pv), '仅后台页面，不含后台 API') +
        kpi('今日后台 IP', fmtNum(adminToday.ips), '今日后台独立 IP') +
        kpi('历史后台 PV', fmtNum(adminHistory.pv), '全部永久历史') +
        kpi('历史后台 IP', fmtNum(adminHistory.ips), '每日去重值累计') +
      '</div></section>' +
      '<section class="metric-block"><div class="metric-heading">全站请求</div><div class="kpi-grid">' +
        kpi('今日总请求', fmtNum(st.today.hits), '页面、API、点击、资源与其他') +
        kpi('今日 API 请求', fmtNum(st.today.api), '公开 ' + fmtNum(publicApiToday.requests) + ' · 后台 ' + fmtNum(adminToday.api)) +
        kpi('历史总请求', fmtNum(st.totals.hits), '全部永久请求记录') +
        kpi('历史总 API 请求', fmtNum(st.totals.api), '已排除链接点击') +
      '</div></section>' +
      '<div class="banner info"><span>ℹ</span><div><b>统计口径：</b>PV 只统计页面展示；文章 PV 仅统计成功打开的文章详情页；文章分享只在系统分享或复制链接成功后记录。链接 PV 是“阅读原文”和友链点击；API 请求不再包含链接点击。UV 与 IP 每天内部去重，第二天同一访客会重新计入，因此本月与历史值均为每日去重结果累计。新访问会保存 IPv4 /24 或 IPv6 /48 网段；完整单机 IP 不在后台明文展示。</div></div>' +
      '<div class="card"><h3><span class="bar"></span>每日页面访问趋势<span class="right">前台 / 文章 / 后台 / 总 PV · 近 ' + visitsRange + ' 天</span></h3>' +
        lineChart([
          { name: '前台 PV', color: '#0b5cff', values: st.days.map(function(d){ return d.scopes.frontend.pv; }) },
          { name: '文章 PV', color: '#16a34a', values: st.days.map(function(d){ return d.articlePv; }) },
          { name: '后台 PV', color: '#7a3cff', values: st.days.map(function(d){ return d.scopes.admin.pv; }) },
          { name: '总页面 PV', color: '#0f9b8e', values: st.days.map(function(d){ return d.pv; }) },
        ], st.days.map(function(d){ return visitsRange > 365 ? d.date : d.date.slice(5); }), { area: true, height: 260 }) +
      '</div>' +
      '<div class="card"><h3><span class="bar"></span>前台访客与互动趋势<span class="right">UV / IP / 链接点击 / 文章分享 · 近 ' + visitsRange + ' 天</span></h3>' +
        lineChart([
          { name: '前台 UV', color: '#0f9b8e', values: st.days.map(function(d){ return d.scopes.frontend.uv; }) },
          { name: '前台 IP', color: '#e35d2b', values: st.days.map(function(d){ return d.scopes.frontend.ips; }) },
          { name: '链接点击', color: '#16a34a', values: st.days.map(function(d){ return d.clicks; }) },
          { name: '文章分享', color: '#7a3cff', values: st.days.map(function(d){ return d.articleShares; }) },
        ], st.days.map(function(d){ return visitsRange > 365 ? d.date : d.date.slice(5); }), { area: true, height: 240 }) +
      '</div>' +
      '<div class="card"><h3><span class="bar"></span>前台访问地域分布<span class="right">所选时段 · IP 为每日去重值累计</span></h3>' +
        '<div class="form-row"><div><h4 style="margin:0 0 8px">国家 / 地区 TOP 20</h4><div class="tbl-wrap"><table class="tbl"><thead><tr><th class="num-c">#</th><th>国家 / 地区</th><th class="num-c">日 IP 次</th><th class="num-c">PV</th><th class="num-c">请求</th></tr></thead><tbody>' + countryRows + '</tbody></table></div></div>' +
        '<div><h4 style="margin:0 0 8px">省份 / 地区 TOP 30</h4><div class="tbl-wrap"><table class="tbl"><thead><tr><th class="num-c">#</th><th>省份 / 地区</th><th>代码</th><th class="num-c">日 IP 次</th><th class="num-c">PV</th><th class="num-c">请求</th></tr></thead><tbody>' + regionRows + '</tbody></table></div></div></div>' +
      '</div>' +
      '<div class="card"><h3><span class="bar"></span>所选时段分区统计<span class="right">页面、API 与链接点击分别计算</span></h3><div class="tbl-wrap"><table class="tbl"><thead><tr><th>访问区域</th><th class="num-c">页面 PV</th><th class="num-c">日 UV 次</th><th class="num-c">日 IP 次</th><th class="num-c">全部请求</th><th class="num-c">API 请求</th></tr></thead><tbody>' + scopeRows + '</tbody></table></div></div>' +
      '<div class="card"><h3><span class="bar"></span>月度访问量<span class="right">全部历史永久保留</span></h3>' +
        '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>月份</th><th class="num-c">前台 PV</th><th class="num-c">前台日 UV</th><th class="num-c">前台日 IP</th><th class="num-c">文章 PV</th><th class="num-c">文章分享</th><th class="num-c">后台 PV</th><th class="num-c">链接点击</th><th class="num-c">公开 API</th><th class="num-c">总请求</th><th class="num-c">日均 PV</th></tr></thead><tbody>' + monthRows + '</tbody></table></div>' +
      '</div>' +
      '<div class="card"><h3><span class="bar"></span>页面明细 TOP 15<span class="right">逐路径区分前台与后台</span></h3><div class="tbl-wrap"><table class="tbl"><thead><tr><th class="num-c">#</th><th>区域</th><th>路径</th><th class="num-c">PV</th><th class="num-c">UV</th><th class="num-c">IP</th></tr></thead><tbody>' + topRows + '</tbody></table></div></div>' +
      '<div class="card"><h3><span class="bar"></span>全部请求路径 TOP 20<span class="right">页面、后台、API、资源与其他</span></h3><div class="tbl-wrap"><table class="tbl"><thead><tr><th class="num-c">#</th><th>区域</th><th>路径</th><th class="num-c">请求</th><th class="num-c">UV</th><th class="num-c">IP</th></tr></thead><tbody>' + routeRows + '</tbody></table></div></div>' +
      '<div class="card"><h3><span class="bar"></span>链接点击 TOP 10<span class="right">情报与友链</span></h3><div class="tbl-wrap"><table class="tbl"><thead><tr><th class="num-c">#</th><th>链接</th><th>类型</th><th class="num-c">点击</th></tr></thead><tbody>' + linkRows + '</tbody></table></div></div>' +
      '<div class="card"><h3><span class="bar"></span>最近访问<span class="right">今日实时</span></h3>' +
        '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>时间</th><th>IP 网段</th><th>国家 / 省份 / 城市</th><th>路径 / 链接</th><th>类型</th><th class="num-c">状态</th></tr></thead><tbody>' + recentRows + '</tbody></table></div>' +
      '</div>';

    el.querySelectorAll('[data-days]').forEach(function(b){
      b.addEventListener('click', function(){
        visitsRange = Number(b.getAttribute('data-days'));
        viewVisits(el);
      });
    });
  }).catch(function(err){
    if (err.status !== 401) el.innerHTML = '<div class="banner warn"><span>⚠</span><div>加载失败：' + esc(err.message || '未知错误') + '</div></div>';
  });
}
// ================= 视图：情报管理 =================
var intelPage = 1, intelSize = 20, intelQuery = '', intelStatus = 'active', intelCategory = '';
var INTEL_CATEGORIES = [
  ['ai-models','模型发布 / 更新'],['ai-products','产品发布 / 更新'],['industry','行业动态'],
  ['paper','论文研究'],['tutorial','教程 / 实战'],['tip','观点 / 方法'],['','未分类']
];
function intelStatusTag(status){
  var map = {
    published: '<span class="tag ok">已发布</span>',
    draft: '<span class="tag info">草稿</span>',
    archived: '<span class="tag mut">已归档</span>',
    deleted: '<span class="tag fail">回收站</span>'
  };
  return map[status] || '<span class="tag mut">' + esc(status) + '</span>';
}
function intelCategoryLabel(slug){
  var found = INTEL_CATEGORIES.find(function(c){ return c[0] === (slug || ''); });
  return found ? found[1] : (slug || '未分类');
}
function intelQuickButton(item){
  if (item.status === 'draft') return '<button class="btn sm btn-solid" data-intel-act="publish" data-id="' + item.id + '">发布</button> ';
  if (item.status === 'archived') return '<button class="btn sm" data-intel-act="publish" data-id="' + item.id + '">重新发布</button> ';
  if (item.status === 'published') return '<button class="btn sm" data-intel-act="draft" data-id="' + item.id + '">转草稿</button> ';
  return '';
}
function viewIntelligence(el){
  loadViewSpinner(el);
  var url = '/api/admin/intelligence?page=' + intelPage + '&size=' + intelSize + '&status=' + encodeURIComponent(intelStatus) +
    '&q=' + encodeURIComponent(intelQuery) + '&category=' + encodeURIComponent(intelCategory);
  apiGet(url).then(function(res){
    var s = res.stats || {};
    var rows = res.items.map(function(item){
      var link = item.originalUrl || item.upstreamUrl;
      return '<tr>' +
        '<td><input type="checkbox" data-intel-check value="' + item.id + '" aria-label="选择：' + esc(item.title) + '" /></td>' +
        '<td><button class="btn sm" data-intel-act="view" data-id="' + item.id + '">查看</button></td>' +
        '<td><span class="intel-title" title="' + esc(item.title) + '">' + esc(item.title) + '</span><span class="hint">' + esc(item.sourceName || '未知来源') + '</span></td>' +
        '<td>' + esc(intelCategoryLabel(item.category)) + '</td>' +
        '<td>' + intelStatusTag(item.status) + '</td>' +
        '<td class="num-c">' + fmtNum(item.seenCount) + '</td>' +
        '<td title="' + esc(item.lastSeenAt) + '">' + esc(fmtDateShort(item.lastSeenAt)) + '</td>' +
        '<td style="white-space:nowrap"><button class="btn sm" data-intel-act="edit" data-id="' + item.id + '">编辑</button> ' +
          (item.status === 'published' ? '<a class="btn sm" href="/article/' + item.id + '" target="_blank" rel="noopener">站内文章</a> ' : '') +
          (link ? '<a class="btn sm" href="' + esc(link) + '" target="_blank" rel="noopener noreferrer">阅读</a> ' : '') +
          intelQuickButton(item) +
          (item.status === 'deleted' ? '<button class="btn sm" data-intel-act="restore" data-id="' + item.id + '">恢复</button>' : '<button class="btn sm danger" data-intel-act="delete" data-id="' + item.id + '">删除</button>') + '</td>' +
      '</tr>';
    }).join('') || '<tr><td colspan="8" class="empty-tip">没有符合条件的情报</td></tr>';
    var statusOptions = [['active','全部有效'],['published','已发布'],['draft','草稿'],['archived','已归档'],['deleted','回收站'],['all','全部状态']];
    var categoryOptions = [['','全部分类']].concat(INTEL_CATEGORIES.filter(function(c){ return !!c[0]; }));
    el.innerHTML = '' +
      '<div class="kpi-grid">' +
        kpi('有效情报', fmtNum(s.active), '库内总记录 ' + fmtNum(s.total)) +
        kpi('已发布', fmtNum(s.published), '草稿 ' + fmtNum(s.draft) + ' · 归档 ' + fmtNum(s.archived), 'good') +
        kpi('避免重复', fmtNum(s.duplicatesPrevented), '采集过程自动合并', 'teal') +
        kpi('数据仓库', fmtBytes(s.storageBytes), '独立信源 ' + fmtNum(s.uniqueSources)) +
      '</div>' +
      '<div class="card">' +
        '<div class="toolbar-row">' +
          '<input type="text" id="intel-q" value="' + esc(intelQuery) + '" placeholder="搜索标题、摘要、来源、链接" style="min-width:260px;flex:1" />' +
          '<select id="intel-status">' + statusOptions.map(function(x){ return '<option value="' + x[0] + '"' + (x[0] === intelStatus ? ' selected' : '') + '>' + x[1] + '</option>'; }).join('') + '</select>' +
          '<select id="intel-category">' + categoryOptions.map(function(x){ return '<option value="' + x[0] + '"' + (x[0] === intelCategory ? ' selected' : '') + '>' + x[1] + '</option>'; }).join('') + '</select>' +
          '<button class="btn" id="intel-search">查询</button>' +
          '<button class="btn" id="intel-reset">重置</button>' +
          '<button class="btn btn-solid" id="intel-add">＋ 新增情报</button>' +
        '</div>' +
        '<div class="banner info"><span>ℹ</span><div>采集内容会先按 ID、原文链接和标题来源核实去重，再合并到情报库。人工编辑字段不会被后续采集覆盖；删除后进入回收站，也不会被采集自动恢复。</div></div>' +
        '<div class="intel-bulkbar"><label><input type="checkbox" id="intel-select-page" /> 选择本页</label><span class="selected-count" id="intel-selected-count">已选 0 条</span>' +
          '<button class="btn sm btn-solid" data-intel-bulk="publish" disabled>发布选中</button><button class="btn sm" data-intel-bulk="draft" disabled>转为草稿</button><button class="btn sm" data-intel-bulk="archive" disabled>归档选中</button>' +
          (intelStatus === 'deleted' || intelStatus === 'all' ? '<button class="btn sm" data-intel-bulk="restore" disabled>恢复并发布</button>' : '') +
          '<button class="btn sm danger" data-intel-bulk="delete" disabled>删除选中</button><span class="spacer"></span>' +
          (s.draft ? '<button class="btn sm btn-solid" id="intel-publish-all-drafts">发布全部草稿（' + fmtNum(s.draft) + '）</button>' : '<span class="tag ok">当前无草稿</span>') +
        '</div>' +
        '<div class="tbl-wrap"><table class="tbl"><thead><tr><th style="width:34px">选择</th><th>详情</th><th>标题 / 来源</th><th>分类</th><th>状态</th><th class="num-c">采集次数</th><th>最近出现</th><th>操作</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
        '<div class="pager"><button class="btn sm" id="intel-prev"' + (res.page <= 1 ? ' disabled' : '') + '>‹ 上一页</button>' +
          '<span class="pg-info">第 ' + res.page + ' / ' + res.pages + ' 页 · 共 ' + fmtNum(res.total) + ' 条</span>' +
          '<button class="btn sm" id="intel-next"' + (res.page >= res.pages ? ' disabled' : '') + '>下一页 ›</button>' +
          '<span class="spacer"></span><select id="intel-size">' + [20,50,100].map(function(n){ return '<option value="' + n + '"' + (n === intelSize ? ' selected' : '') + '>每页 ' + n + '</option>'; }).join('') + '</select></div>' +
      '</div>';
    var submitSearch = function(){ intelQuery = $('intel-q').value.trim(); intelStatus = $('intel-status').value; intelCategory = $('intel-category').value; intelPage = 1; viewIntelligence(el); };
    $('intel-search').addEventListener('click', submitSearch);
    $('intel-reset').addEventListener('click', function(){ intelQuery=''; intelStatus='active'; intelCategory=''; intelPage=1; viewIntelligence(el); });
    $('intel-q').addEventListener('keydown', function(e){ if (e.key === 'Enter') submitSearch(); });
    $('intel-status').addEventListener('change', submitSearch);
    $('intel-category').addEventListener('change', submitSearch);
    $('intel-add').addEventListener('click', function(){ openIntelEditor(null, el); });
    $('intel-prev').addEventListener('click', function(){ if (res.page > 1) { intelPage = res.page - 1; viewIntelligence(el); } });
    $('intel-next').addEventListener('click', function(){ if (res.page < res.pages) { intelPage = res.page + 1; viewIntelligence(el); } });
    $('intel-size').addEventListener('change', function(){ intelSize = Number(this.value); intelPage = 1; viewIntelligence(el); });
    var rowChecks = Array.prototype.slice.call(el.querySelectorAll('[data-intel-check]'));
    var syncSelection = function(){
      var selected = rowChecks.filter(function(n){ return n.checked; });
      $('intel-selected-count').textContent = '已选 ' + selected.length + ' 条';
      el.querySelectorAll('[data-intel-bulk]').forEach(function(button){ button.disabled = selected.length === 0; });
      $('intel-select-page').checked = rowChecks.length > 0 && selected.length === rowChecks.length;
      $('intel-select-page').indeterminate = selected.length > 0 && selected.length < rowChecks.length;
    };
    rowChecks.forEach(function(node){ node.addEventListener('change', syncSelection); });
    $('intel-select-page').addEventListener('change', function(){ var checked=this.checked; rowChecks.forEach(function(node){ node.checked=checked; }); syncSelection(); });
    el.querySelectorAll('[data-intel-bulk]').forEach(function(button){
      button.addEventListener('click', function(){
        var action = button.getAttribute('data-intel-bulk');
        var ids = rowChecks.filter(function(n){ return n.checked; }).map(function(n){ return n.value; });
        if (!ids.length) return;
        var labels = {publish:'发布',draft:'转为草稿',archive:'归档',restore:'恢复并发布',delete:'删除'};
        if ((action === 'delete' || action === 'archive' || action === 'draft') && !confirm('确定将选中的 ' + ids.length + ' 条情报' + labels[action] + '？')) return;
        button.disabled = true;
        apiPost('/api/admin/intelligence/bulk', { action:action, ids:ids }).then(function(r){ toast('批量' + labels[action] + '完成：更新 ' + r.result.changed + ' 条'); viewIntelligence(el); }).catch(function(err){ toast(err.message || '批量操作失败','err'); button.disabled=false; });
      });
    });
    if ($('intel-publish-all-drafts')) $('intel-publish-all-drafts').addEventListener('click', function(){
      if (!confirm('确定发布全部 ' + s.draft + ' 条草稿？发布后会进入前台情报流与可索引文章。')) return;
      var button=this; button.disabled=true;
      apiPost('/api/admin/intelligence/bulk', { action:'publish', allMatching:true, status:'draft' }).then(function(r){ toast('全部草稿已发布，共更新 ' + r.result.changed + ' 条'); intelStatus='published'; intelPage=1; viewIntelligence(el); }).catch(function(err){ toast(err.message || '发布失败','err'); button.disabled=false; });
    });
    el.querySelectorAll('[data-intel-act]').forEach(function(btn){
      btn.addEventListener('click', function(){
        var id = btn.getAttribute('data-id'), act = btn.getAttribute('data-intel-act');
        if (act === 'view') return openIntelDetail(id, el);
        if (act === 'edit') return openIntelEditor(id, el);
        if (act === 'publish' || act === 'draft' || act === 'archive') {
          var nextStatus = act === 'publish' ? 'published' : act === 'archive' ? 'archived' : 'draft';
          btn.disabled = true;
          return apiPatch('/api/admin/intelligence/' + id, {status:nextStatus}).then(function(){ toast(act === 'publish' ? '情报已发布' : act === 'draft' ? '已转为草稿' : '情报已归档'); viewIntelligence(el); }).catch(function(err){ toast(err.message || '状态更新失败','err'); btn.disabled=false; });
        }
        if (act === 'restore') return apiPost('/api/admin/intelligence/' + id + '/restore').then(function(){ toast('情报已恢复'); viewIntelligence(el); }).catch(function(err){ toast(err.message || '恢复失败','err'); });
        if (act === 'delete' && confirm('确定删除这条情报？它会进入回收站，并从公开看板隐藏。')) {
          apiDelete('/api/admin/intelligence/' + id).then(function(){ toast('情报已移入回收站'); viewIntelligence(el); }).catch(function(err){ toast(err.message || '删除失败','err'); });
        }
      });
    });
  }).catch(function(err){ if (err.status !== 401) el.innerHTML = '<div class="banner warn"><span>⚠</span><div>加载失败：' + esc(err.message || '未知错误') + '</div></div>'; });
}

function openIntelDetail(id, listEl){
  var mask = $('snap-modal'), body = $('snap-modal-body');
  $('snap-modal-title').textContent = '情报详情';
  body.innerHTML = '<div class="loading-tip"><div class="spin"></div><div>加载中…</div></div>';
  mask.classList.add('show');
  apiGet('/api/admin/intelligence/' + id).then(function(r){
    var item = r.item, link = item.originalUrl || item.upstreamUrl;
    var detailQuick = item.status === 'draft' || item.status === 'archived' ? '<button class="btn btn-solid" id="intel-detail-status" data-status="published">立即发布</button>' : item.status === 'published' ? '<button class="btn" id="intel-detail-status" data-status="draft">转为草稿</button>' : '';
    body.innerHTML = '<div class="toolbar-row">' + intelStatusTag(item.status) + '<span class="tag mut">' + esc(intelCategoryLabel(item.category)) + '</span><span class="spacer"></span>' + detailQuick + '<button class="btn btn-solid" id="intel-detail-edit">编辑</button></div>' +
      '<h2 style="font-size:20px;line-height:1.45;margin:10px 0">' + esc(item.title) + '</h2>' +
      '<div class="intel-summary">' + esc(item.summary || '暂无摘要') + '</div>' +
      '<table class="tbl" style="margin-top:18px"><tbody>' +
        '<tr><td style="color:var(--text-3)">来源</td><td>' + esc(item.sourceName || '未知来源') + '</td></tr>' +
        '<tr><td style="color:var(--text-3)">首次入库</td><td>' + esc(fmtTime(item.firstSeenAt)) + '</td></tr>' +
        '<tr><td style="color:var(--text-3)">最近采集</td><td>' + esc(fmtTime(item.lastSeenAt)) + ' · 累计 ' + fmtNum(item.seenCount) + ' 次</td></tr>' +
        '<tr><td style="color:var(--text-3)">展示窗口</td><td>' + esc((item.windows || []).join('、') || '无') + '</td></tr>' +
        '<tr><td style="color:var(--text-3)">链接</td><td>' + (link ? '<a href="' + esc(link) + '" target="_blank" rel="noopener noreferrer">打开原文 ↗</a>' : '—') + '</td></tr>' +
      '</tbody></table>';
    $('intel-detail-edit').addEventListener('click', function(){ openIntelEditor(id, listEl); });
    if ($('intel-detail-status')) $('intel-detail-status').addEventListener('click', function(){ var button=this; button.disabled=true; apiPatch('/api/admin/intelligence/' + id, {status:button.getAttribute('data-status')}).then(function(){ toast(button.getAttribute('data-status') === 'published' ? '情报已发布' : '已转为草稿'); mask.classList.remove('show'); viewIntelligence(listEl); }).catch(function(err){ toast(err.message || '状态更新失败','err'); button.disabled=false; }); });
  }).catch(function(err){ body.innerHTML = '<div class="banner warn"><span>⚠</span><div>' + esc(err.message || '加载失败') + '</div></div>'; });
}

function openIntelEditor(id, listEl){
  var mask = $('snap-modal'), body = $('snap-modal-body');
  $('snap-modal-title').textContent = id ? '编辑情报' : '新增情报';
  body.innerHTML = '<div class="loading-tip"><div class="spin"></div><div>准备表单…</div></div>';
  mask.classList.add('show');
  var promise = id ? apiGet('/api/admin/intelligence/' + id).then(function(r){ return r.item; }) : Promise.resolve({ status:'published', windows:['7d'], title:'', summary:'', category:'', sourceName:'', originalUrl:'', upstreamUrl:'', publishedAt:'' });
  promise.then(function(item){
    var catOptions = INTEL_CATEGORIES.map(function(c){ return '<option value="' + c[0] + '"' + (c[0] === (item.category || '') ? ' selected' : '') + '>' + c[1] + '</option>'; }).join('');
    var statusOptions = [['published','已发布'],['draft','草稿'],['archived','已归档']].map(function(s){ return '<option value="' + s[0] + '"' + (s[0] === item.status ? ' selected' : '') + '>' + s[1] + '</option>'; }).join('');
    var wins = item.windows || [];
    var winCheck = function(v,label){ return '<label><input type="checkbox" data-intel-window="' + v + '"' + (wins.indexOf(v) !== -1 ? ' checked' : '') + ' /> ' + label + '</label>'; };
    body.innerHTML = '<div class="field"><label>标题 *</label><input type="text" id="intel-edit-title" maxlength="500" value="' + esc(item.title) + '" style="width:100%" /></div>' +
      '<div class="field"><label>摘要</label><textarea id="intel-edit-summary" maxlength="8000" rows="7">' + esc(item.summary || '') + '</textarea></div>' +
      '<div class="form-row"><div class="field"><label>分类</label><select id="intel-edit-category" style="width:100%">' + catOptions + '</select></div>' +
        '<div class="field"><label>状态</label><select id="intel-edit-status" style="width:100%">' + statusOptions + '</select></div></div>' +
      '<div class="form-row"><div class="field"><label>来源名称</label><input type="text" id="intel-edit-source" maxlength="300" value="' + esc(item.sourceName || '') + '" style="width:100%" /></div>' +
        '<div class="field"><label>发布时间</label><input type="text" id="intel-edit-published" value="' + esc(item.publishedAt || '') + '" placeholder="ISO 时间或文字时间" style="width:100%" /></div></div>' +
      '<div class="field"><label>原文链接</label><input type="text" id="intel-edit-original" value="' + esc(item.originalUrl || '') + '" placeholder="https://" style="width:100%" /></div>' +
      '<div class="field"><label>采集链接</label><input type="text" id="intel-edit-upstream" value="' + esc(item.upstreamUrl || '') + '" placeholder="https://" style="width:100%" /><div class="hint">记录自动采集时使用的数据链接，仅供后台核对。</div></div>' +
      '<div class="field"><label>展示位置</label><div class="check-row">' + winCheck('7d','近 7 天') + winCheck('24h','近 24 小时') + winCheck('hot','当前热点') + winCheck('daily','今日日报') + '</div></div>' +
      (id ? '<div class="hint">采集字段与人工修改分开保存，后续自动采集不会覆盖这里的人工编辑。</div>' : '<div class="hint">手工新增的情报会直接保存到后端情报库，并按选择的展示位置进入公开看板。</div>') +
      '<div class="form-actions"><button class="btn btn-solid" id="intel-edit-save">保存</button><button class="btn" id="intel-edit-cancel">取消</button></div>';
    $('intel-edit-cancel').addEventListener('click', function(){ mask.classList.remove('show'); });
    $('intel-edit-save').addEventListener('click', function(){
      var payload = {
        title: $('intel-edit-title').value.trim(), summary: $('intel-edit-summary').value.trim(), category: $('intel-edit-category').value,
        status: $('intel-edit-status').value, sourceName: $('intel-edit-source').value.trim(), publishedAt: $('intel-edit-published').value.trim(),
        originalUrl: $('intel-edit-original').value.trim(), upstreamUrl: $('intel-edit-upstream').value.trim(),
        windows: Array.prototype.slice.call(body.querySelectorAll('[data-intel-window]:checked')).map(function(n){ return n.getAttribute('data-intel-window'); })
      };
      var btn = this; btn.disabled = true;
      (id ? apiPatch('/api/admin/intelligence/' + id, payload) : apiPost('/api/admin/intelligence', payload)).then(function(){
        toast(id ? '情报已更新' : '情报已创建'); mask.classList.remove('show'); viewIntelligence(listEl);
      }).catch(function(err){ toast(err.message || '保存失败','err'); btn.disabled = false; });
    });
  }).catch(function(err){ body.innerHTML = '<div class="banner warn"><span>⚠</span><div>' + esc(err.message || '加载失败') + '</div></div>'; });
}

// ================= 视图：数据快照 =================
var snapPage = 1, snapSize = 20;
function viewSnapshots(el){
  loadViewSpinner(el);
  apiGet('/api/admin/snapshots?page=' + snapPage + '&size=' + snapSize).then(function(res){
    var pageLink = function(p, label, dis){
      return '<button class="btn sm" data-page="' + p + '"' + (dis ? ' disabled' : '') + '>' + label + '</button>';
    };
    el.innerHTML = '' +
      '<div class="toolbar-row">' +
        '<button class="btn btn-solid" id="snap-collect">⟳ 立即采集</button>' +
        '<button class="btn" id="snap-refresh">刷新列表</button>' +
        '<span class="spacer"></span>' +
        '<span style="font-size:12px;color:var(--text-3)">每页</span>' +
        '<select id="snap-size">' + [20, 50, 100].map(function(n){ return '<option value="' + n + '"' + (n === snapSize ? ' selected' : '') + '>' + n + ' 条</option>'; }).join('') + '</select>' +
      '</div>' +
      '<div class="banner info"><span>ℹ</span><div>每次采集（自动 / 手动）都会完整落盘一份快照，即使数据源失效也可回溯任意历史数据；内容完全相同的快照自动去重复用，节省磁盘。</div></div>' +
      '<div class="card">' +
        '<h3><span class="bar"></span>快照列表<span class="right">共 ' + fmtNum(res.total) + ' 条记录 · 第 ' + res.page + ' / ' + res.pages + ' 页</span></h3>' +
        snapshotTable(res, false) +
        '<div class="pager">' +
          pageLink(res.page - 1, '‹ 上一页', res.page <= 1) +
          '<span class="pg-info">第 ' + res.page + ' / ' + res.pages + ' 页 · 共 ' + fmtNum(res.total) + ' 条</span>' +
          pageLink(res.page + 1, '下一页 ›', res.page >= res.pages) +
        '</div>' +
      '</div>';

    var doCollect = function(){
      var btn = $('snap-collect');
      btn.disabled = true; btn.textContent = '采集中…';
      apiPost('/api/admin/collect').then(function(r){
        toast('采集成功：' + ((r.entry && r.entry.counts) ? (r.entry.counts.w7 + ' 条 7d / ' + r.entry.counts.w24 + ' 条 24h') : '完成'));
        viewSnapshots(el);
      }).catch(function(err){
        btn.disabled = false; btn.textContent = '⟳ 立即采集';
        toast('采集失败：' + (err.message || '未知错误'), 'err');
      });
    };
    $('snap-collect').addEventListener('click', function(){
      if (confirm('确定立即从已启用的数据源采集一次最新数据？')) doCollect();
    });
    $('snap-refresh').addEventListener('click', function(){ viewSnapshots(el); });
    $('snap-size').addEventListener('change', function(){
      snapSize = Number(this.value); snapPage = 1; viewSnapshots(el);
    });
    el.querySelectorAll('[data-page]').forEach(function(b){
      b.addEventListener('click', function(){
        var p = Number(b.getAttribute('data-page'));
        if (p >= 1 && p <= res.pages) { snapPage = p; viewSnapshots(el); }
      });
    });
    el.querySelectorAll('[data-act="view"]').forEach(function(b){
      b.addEventListener('click', function(){ openSnapshot(b.getAttribute('data-id')); });
    });
    el.querySelectorAll('[data-act="del"]').forEach(function(b){
      b.addEventListener('click', function(){
        var id = b.getAttribute('data-id');
        if (confirm('确定删除快照 ' + id + ' ？该操作不可恢复。')) {
          apiDelete('/api/admin/snapshots/' + encodeURIComponent(id)).then(function(){
            toast('已删除 ' + id);
            viewSnapshots(el);
          }).catch(function(err){ toast('删除失败：' + (err.message || '未知错误'), 'err'); });
        }
      });
    });
  }).catch(function(err){
    if (err.status !== 401) el.innerHTML = '<div class="banner warn"><span>⚠</span><div>加载失败：' + esc(err.message || '未知错误') + '</div></div>';
  });
}

function openSnapshot(id){
  var mask = $('snap-modal'), body = $('snap-modal-body');
  $('snap-modal-title').textContent = '快照 ' + id;
  body.innerHTML = '<div class="loading-tip"><div class="spin"></div><div>加载中…</div></div>';
  mask.classList.add('show');
  apiGet('/api/admin/snapshots/' + encodeURIComponent(id)).then(function(r){
    var m = r.meta, d = r.data;
    var items = [];
    (d.window7d || []).forEach(function(it){ items.push({ t: it, tag: '7d' }); });
    (d.window24h || []).forEach(function(it){ items.push({ t: it, tag: '24h' }); });
    (d.hot || []).forEach(function(it){ items.push({ t: it, tag: '热点' }); });
    var dailyCount = 0;
    if (d.daily && d.daily.report && d.daily.report.sections) {
      d.daily.report.sections.forEach(function(sec){ (sec.items || []).forEach(function(it){ dailyCount++; items.push({ t: it, tag: '日报' }); }); });
    }
    var CAP = 500;
    var listHtml = items.slice(0, CAP).map(function(x){
      var it = x.t;
      var url = (it.links && (it.links.original || it.links.upstream)) || '#';
      return '<tr><td><span class="tag mut">' + x.tag + '</span></td>' +
        '<td><a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + esc(it.title || '(无标题)') + '</a></td>' +
        '<td>' + esc(it.source && it.source.name || '—') + '</td>' +
        '<td style="white-space:nowrap" title="' + esc(it.publishedAt || it.discoveredAt || '') + '">' + esc(fmtDateShort(it.publishedAt || it.discoveredAt)) + '</td></tr>';
    }).join('');
    body.innerHTML = '' +
      '<div class="kpi-grid" style="margin-bottom:14px">' +
        kpi('采集时间', '<small style="font-size:14px">' + esc(fmtTime(m.fetchedAt)) + '</small>', '耗时 ' + fmtMs(m.durationMs)) +
        kpi('7 天窗条目', fmtNum(m.counts && m.counts.w7), '精选池') +
        kpi('24 小时窗条目', fmtNum(m.counts && m.counts.w24), '精选池') +
        kpi('热点 / 日报', fmtNum(m.counts && m.counts.hot) + '<small> / ' + dailyCount + '</small>', '聚合热点 · 日报条目') +
      '</div>' +
      '<div style="font-size:12px;color:var(--text-3);margin-bottom:10px" class="mono">SHA-256: ' + esc(m.sha256 || '—') + ' · 大小 ' + fmtBytes(m.bytes) + (m.sameAs ? ' · 去重复用（引用 ' + esc(m.sameAs) + '）' : '') + '</div>' +
      '<div class="tbl-wrap" style="max-height:480px;overflow:auto"><table class="tbl"><thead><tr><th>类型</th><th>标题</th><th>来源</th><th>发布时间</th></tr></thead><tbody>' + listHtml + '</tbody></table></div>' +
      (items.length > CAP ? '<div class="hint" style="margin-top:8px">条目较多，仅展示前 ' + CAP + ' 条（共 ' + items.length + ' 条）。</div>' : '');
  }).catch(function(err){
    body.innerHTML = '<div class="banner warn"><span>⚠</span><div>加载失败：' + esc(err.message || '未知错误') + '</div></div>';
  });
}

// ================= 视图：接口管理 =================
var endpointActiveId = null;
function endpointRole(role){
  return ({ collector:'主采集', archive:'归档', 'on-demand':'按需查询', sync:'完整同步', source:'外部信源' })[role] || role || '—';
}
function endpointStatus(item){
  if (!item.enabled) return '<span class="tag mut">已停用</span>';
  var state = item.state;
  if (!state || !state.lastAt) return '<span class="tag mut">待检测</span>';
  if (state.lastStatus === 'ok' || state.lastStatus === 'not_modified') return '<span class="tag ok">正常</span>';
  if (state.lastStatus === 'fallback') return '<span class="tag info">已回退</span>';
  return '<span class="tag fail">异常</span>';
}
function testEndpointButton(btn, id, el){
  btn.disabled = true; btn.textContent = '检测中…';
  apiPost('/api/admin/endpoints/' + encodeURIComponent(id) + '/test').then(function(r){
    var result = r.result || {};
    toast(result.ok ? '接口检测成功：HTTP ' + result.httpStatus + '，' + fmtMs(result.durationMs) : '接口检测失败：' + (result.error || '未知错误'), result.ok ? 'ok' : 'err');
    viewEndpoints(el);
  }).catch(function(err){ toast(err.message || '接口检测失败', 'err'); })
    .finally(function(){ btn.disabled = false; btn.textContent = '立即检测'; });
}
function viewEndpoints(el){
  if (endpointActiveId) return viewEndpointDetail(el, endpointActiveId);
  loadViewSpinner(el);
  apiGet('/api/admin/endpoints').then(function(r){
    var s = r.summary || {}, items = r.items || [];
    var rows = items.map(function(item){
      var state = item.state || {};
      return '<tr>' +
        '<td><b>' + esc(item.name) + '</b><div class="mono" style="color:var(--text-3)">' + esc(item.id) + '</div></td>' +
        '<td><span class="tag info">' + esc(endpointRole(item.role)) + '</span></td>' +
        '<td style="min-width:280px;max-width:420px"><div class="mono" style="word-break:break-all">' + esc(item.url) + '</div><div style="color:var(--text-3);font-size:11px;margin-top:3px">' + esc(item.schedule || '') + '</div></td>' +
        '<td>' + endpointStatus(item) + '</td>' +
        '<td>' + fmtNum(state.lastCount) + '<div style="color:var(--text-3);font-size:11px">' + fmtMs(state.lastDurationMs) + '</div></td>' +
        '<td style="white-space:nowrap">' + esc(fmtTime(state.lastAt)) + '</td>' +
        '<td style="white-space:nowrap"><button class="btn sm" data-ep-view="' + esc(item.id) + '">查看 / 编辑</button> <button class="btn sm" data-ep-test="' + esc(item.id) + '">立即检测</button></td>' +
      '</tr>';
    }).join('');
    var starterOnly = items.length === 1 && items[0].id === 'aiqbRss';
    var sourceIntro = starterOnly
      ? '全新安装默认只启用 AI圈报 RSS，开箱即可获得基础 AI 情报。你可以停用它，或继续添加自己的公网 HTTPS JSON、RSS、Atom 接口。'
      : '这里统一管理全部采集接口、真实检测结果和调用日志。你可以添加无需登录的公网 HTTPS JSON、RSS 或 Atom 数据源。';
    el.innerHTML = '' +
      '<div class="banner info"><span>ℹ</span><div>' + sourceIntro + '</div></div>' +
      '<div class="toolbar-row"><button class="btn btn-solid" id="ep-add">＋ 添加接口</button><span class="spacer"></span><span class="hint">自定义 ' + fmtNum(s.custom) + ' 个 · 外部信源 ' + fmtNum(s.source) + ' 个 · 请求并发上限 3</span></div>' +
      '<div class="kpi-grid">' +
        kpi('接口总数', fmtNum(s.total), '统一登记与审计') +
        kpi('当前启用', fmtNum(s.enabled), '主采集 + 归档 + 按需', 'good') +
        kpi('健康接口', fmtNum(s.healthy), '最近一次调用正常', 'teal') +
        kpi('异常 / 待检测', fmtNum((s.error || 0) + (s.idle || 0)), '异常 ' + fmtNum(s.error) + ' · 待检测 ' + fmtNum(s.idle), (s.error ? 'warn' : '')) +
      '</div>' +
      '<div class="card"><h3><span class="bar"></span>接口清单<span class="right">状态、耗时与条目数均来自真实调用</span></h3><div class="tbl-wrap"><table class="tbl"><thead><tr><th>接口</th><th>类型</th><th>请求地址 / 调度</th><th>状态</th><th>条目 / 耗时</th><th>最近调用</th><th>操作</th></tr></thead><tbody>' + (rows || '<tr><td colspan="7"><div class="empty-tip">尚未配置采集接口。点击“添加接口”接入公开 JSON、RSS 或 Atom。</div></td></tr>') + '</tbody></table></div></div>';
    el.querySelectorAll('[data-ep-view]').forEach(function(btn){ btn.addEventListener('click', function(){ endpointActiveId = this.getAttribute('data-ep-view'); viewEndpoints(el); }); });
    el.querySelectorAll('[data-ep-test]').forEach(function(btn){ btn.addEventListener('click', function(){ testEndpointButton(this, this.getAttribute('data-ep-test'), el); }); });
    $('ep-add').addEventListener('click', function(){ viewEndpointCreate(el); });
  }).catch(function(err){ if (err.status !== 401) el.innerHTML = '<div class="banner warn"><span>⚠</span><div>加载失败：' + esc(err.message || '未知错误') + '</div></div>'; });
}

function viewEndpointCreate(el){
  el.innerHTML = '' +
    '<div class="toolbar-row"><button class="btn" id="ep-create-back">← 返回接口清单</button></div>' +
    '<div class="banner info"><span>🛡</span><div>仅支持无需登录的公网 HTTPS GET 接口。系统会阻止内网 IP、危险 DNS、重定向和超过 2 MB 的响应；新接口默认关闭且采集结果默认进入草稿审核。</div></div>' +
    '<div class="card"><h3><span class="bar"></span>添加轻量信息接口</h3>' +
      '<div class="form-row"><div class="field"><label>接口名称</label><input id="epc-name" type="text" maxlength="80" placeholder="例如：我的 AI 资讯 RSS" /></div><div class="field"><label>来源显示名</label><input id="epc-source" type="text" maxlength="120" placeholder="例如：Example Tech" /></div></div>' +
      '<div class="field"><label>公网 HTTPS 地址</label><input id="epc-url" type="text" maxlength="2000" style="width:100%" placeholder="https://example.com/feed.xml" /></div>' +
      '<div class="form-row"><div class="field"><label>响应格式</label><select id="epc-format" style="width:100%"><option value="json">JSON</option><option value="rss">RSS</option><option value="atom">Atom</option></select></div><div class="field"><label>内容分类</label><select id="epc-category" style="width:100%"><option value="industry">行业动态</option><option value="ai-models">模型发布 / 更新</option><option value="ai-products">产品发布 / 更新</option><option value="paper">论文研究</option><option value="tutorial">教程 / 实战</option><option value="tip">观点 / 方法</option></select></div></div>' +
      '<div class="form-row"><div class="field"><label>每次最多条目</label><input id="epc-max" type="number" min="1" max="50" value="20" /></div><div class="field"><label>保存状态</label><select id="epc-publish" style="width:100%"><option value="published">核实去重后直接发布（推荐）</option><option value="draft">保存为草稿，后台审核后发布</option></select></div></div>' +
      '<div id="epc-json"><div class="field"><label>JSON 条目数组路径</label><input id="epc-items" type="text" style="width:100%" placeholder="留空表示响应根数组；例如 data.items" /></div>' +
        '<div class="form-row"><div class="field"><label>标题字段</label><input id="epc-title" type="text" value="title" /></div><div class="field"><label>摘要字段</label><input id="epc-summary" type="text" value="description" /></div></div>' +
        '<div class="form-row"><div class="field"><label>原文链接字段</label><input id="epc-link" type="text" value="url" /></div><div class="field"><label>发布时间字段</label><input id="epc-date" type="text" value="published_at" /></div></div></div>' +
      '<div class="field"><label>说明</label><textarea id="epc-description" maxlength="1000" rows="3" placeholder="记录接口用途、维护者或数据范围"></textarea></div>' +
      '<div class="check-row"><label><input id="epc-enabled" type="checkbox" /> 创建后立即启用</label></div>' +
      '<div class="form-actions"><button class="btn btn-solid" id="epc-save">创建接口</button></div>' +
    '</div>';
  var syncFormat = function(){ $('epc-json').style.display = $('epc-format').value === 'json' ? 'block' : 'none'; };
  $('epc-format').addEventListener('change', syncFormat); syncFormat();
  $('ep-create-back').addEventListener('click', function(){ viewEndpoints(el); });
  $('epc-save').addEventListener('click', function(){
    var btn = this; btn.disabled = true;
    apiPost('/api/admin/endpoints', { name:$('epc-name').value.trim(), sourceName:$('epc-source').value.trim(), url:$('epc-url').value.trim(), format:$('epc-format').value, category:$('epc-category').value, maxItems:Number($('epc-max').value), publishMode:$('epc-publish').value, itemsPath:$('epc-items').value.trim(), titlePath:$('epc-title').value.trim(), summaryPath:$('epc-summary').value.trim(), urlPath:$('epc-link').value.trim(), datePath:$('epc-date').value.trim(), description:$('epc-description').value, enabled:$('epc-enabled').checked }).then(function(r){ toast('接口已创建'); endpointActiveId = r.item.id; viewEndpoints(el); }).catch(function(err){ toast(err.message || '创建失败','err'); }).finally(function(){ btn.disabled = false; });
  });
}
function viewEndpointDetail(el, id){
  loadViewSpinner(el);
  apiGet('/api/admin/endpoints/' + encodeURIComponent(id)).then(function(r){
    var item = r.item, state = item.state || {}, logs = item.logs || [];
    var logRows = logs.map(function(log){
      var cls = log.status === 'ok' || log.status === 'not_modified' ? 'ok' : (log.status === 'fallback' ? 'info' : log.status === 'disabled' ? 'mut' : 'fail');
      return '<tr><td style="white-space:nowrap">' + esc(fmtTime(log.at)) + '</td><td><span class="tag ' + cls + '">' + esc(log.status) + '</span></td><td>' + esc(log.trigger || '—') + '</td><td>' + esc(log.httpStatus || '—') + '</td><td>' + fmtNum(log.count) + '</td><td>' + fmtMs(log.durationMs) + '</td><td style="max-width:300px;word-break:break-word;color:' + (log.error ? 'var(--red)' : 'var(--text-3)') + '">' + esc(log.error || log.etag || '—') + '</td></tr>';
    }).join('');
    var cached = item.cached && item.cached.data ? '<pre class="log-pre" style="max-height:360px">' + esc(JSON.stringify(item.cached.data, null, 2)) + '</pre>' : '<div class="empty-tip">尚无缓存响应；点击“立即检测”后可在这里查看经过长度限制的安全预览。</div>';
    var sourceFields = item.role === 'source' ? '<div class="form-row"><div class="field"><label>保存状态</label><select id="ep-publish" style="width:100%"><option value="draft"' + (item.publishMode !== 'published' ? ' selected' : '') + '>草稿（审核后发布）</option><option value="published"' + (item.publishMode === 'published' ? ' selected' : '') + '>直接发布</option></select></div><div class="field"><label>格式 / 每次上限</label><div style="padding:8px 0"><span class="tag info">' + esc(String(item.format || 'json').toUpperCase()) + '</span> · 最多 ' + fmtNum(item.maxItems) + ' 条</div></div></div>' : '';
    var customFields = item.custom ? '<div class="card"><h3><span class="bar"></span>JSON 字段映射<span class="right">RSS / Atom 自动识别标准字段</span></h3><div class="form-row"><div class="field"><label>格式</label><select id="ep-format"><option value="json"' + (item.format === 'json' ? ' selected' : '') + '>JSON</option><option value="rss"' + (item.format === 'rss' ? ' selected' : '') + '>RSS</option><option value="atom"' + (item.format === 'atom' ? ' selected' : '') + '>Atom</option></select></div><div class="field"><label>数组路径</label><input id="ep-items-path" type="text" value="' + esc(item.itemsPath || '') + '" /></div></div><div class="form-row"><div class="field"><label>标题字段</label><input id="ep-title-path" type="text" value="' + esc(item.titlePath || 'title') + '" /></div><div class="field"><label>摘要字段</label><input id="ep-summary-path" type="text" value="' + esc(item.summaryPath || 'description') + '" /></div></div><div class="form-row"><div class="field"><label>链接字段</label><input id="ep-url-path" type="text" value="' + esc(item.urlPath || 'url') + '" /></div><div class="field"><label>日期字段</label><input id="ep-date-path" type="text" value="' + esc(item.datePath || 'published_at') + '" /></div></div></div>' : '';
    el.innerHTML = '' +
      '<div class="toolbar-row"><button class="btn" id="ep-back">← 返回接口清单</button><span class="spacer"></span>' + (item.docsUrl ? '<a class="btn" href="' + esc(item.docsUrl) + '" target="_blank" rel="noopener noreferrer">官方文档 ↗</a>' : '') + (item.custom ? '<button class="btn danger" id="ep-delete">删除接口</button>' : '') + '<button class="btn btn-solid" id="ep-test">立即检测</button></div>' +
      (item.role === 'sync' ? '<div class="banner info"><span>ℹ</span><div>该接口用于精选池全量同步：首次自动分页引导全部精选条目入库，之后每轮采集按 cursor 增量更新，数据源游标失效时会自动重新引导。停用后同步暂停，不影响主采集。</div></div>' : '') +
      '<div class="kpi-grid">' +
        kpi('当前状态', endpointStatus(item), 'HTTP ' + esc(state.lastHttpStatus || '—')) +
        kpi('调用次数', fmtNum(state.attempts || 0), '成功 ' + fmtNum(state.successes || 0) + ' · 失败 ' + fmtNum(state.failures || 0)) +
        kpi('最近条目', fmtNum(state.lastCount), '累计处理 ' + fmtNum(state.totalItems || 0)) +
        kpi('最近耗时', fmtMs(state.lastDurationMs), esc(fmtTime(state.lastAt))) +
      '</div>' +
      '<div class="card"><h3><span class="bar"></span>接口设置<span class="right">' + esc(item.source) + ' · ' + esc(endpointRole(item.role)) + '</span></h3>' +
        '<div class="form-row"><div class="field"><label>接口名称</label><input type="text" id="ep-name" maxlength="80" value="' + esc(item.name) + '" /></div><div class="field"><label>状态</label><div class="check-row" style="padding:8px 0"><label><input type="checkbox" id="ep-enabled"' + (item.enabled ? ' checked' : '') + '> 启用此接口</label></div></div></div>' +
        '<div class="field"><label>接口 URL</label><input type="text" id="ep-url" style="width:100%" maxlength="2000" value="' + esc(item.url) + '" /><div class="hint">' + (item.custom ? '仅允许公网 HTTPS；请求前会校验 DNS，拒绝内网、重定向和超过 2 MB 的响应。' : '内置接口只能使用已登记的官方域名。') + '</div></div>' +
        '<div class="field"><label>说明</label><textarea id="ep-description" maxlength="1000" rows="4">' + esc(item.description || '') + '</textarea></div>' +
        sourceFields +
        '<div class="form-row"><div class="field"><label>请求超时（毫秒）</label><input type="number" id="ep-timeout" min="3000" max="120000" value="' + item.timeoutMs + '" /></div><div class="field"><label>失败重试次数</label><input type="number" id="ep-retries" min="0" max="5" value="' + item.retries + '" /></div></div>' +
        '<div class="form-actions"><button class="btn btn-solid" id="ep-save">保存接口设置</button><span class="hint">请求方法固定为 GET · 调度：' + esc(item.schedule) + '</span></div>' +
      '</div>' + customFields +
      '<div class="card"><h3><span class="bar"></span>最近响应信息<span class="right">ETag / Cache-Control / Request ID</span></h3><table class="tbl"><tbody>' +
        '<tr><td style="color:var(--text-3)">ETag</td><td class="mono">' + esc(state.lastEtag || '—') + '</td></tr><tr><td style="color:var(--text-3)">Cache-Control</td><td class="mono">' + esc(state.lastCacheControl || '—') + '</td></tr><tr><td style="color:var(--text-3)">响应大小</td><td>' + fmtBytes(state.lastBytes) + '</td></tr><tr><td style="color:var(--text-3)">Request ID</td><td class="mono">' + esc(state.lastRequestId || '—') + '</td></tr><tr><td style="color:var(--text-3)">最近错误</td><td style="color:' + (state.lastError ? 'var(--red)' : 'var(--text-3)') + '">' + esc(state.lastError || '—') + '</td></tr></tbody></table></div>' +
      '<div class="card"><h3><span class="bar"></span>响应数据预览<span class="right">最多 10 条 / 字段长度受限</span></h3>' + cached + '</div>' +
      '<div class="card"><h3><span class="bar"></span>接口调用日志<span class="right">最近 ' + logs.length + ' 条</span></h3><div class="tbl-wrap"><table class="tbl"><thead><tr><th>时间</th><th>状态</th><th>触发方式</th><th>HTTP</th><th>条目</th><th>耗时</th><th>错误 / ETag</th></tr></thead><tbody>' + (logRows || '<tr><td colspan="7"><div class="empty-tip">暂无调用记录</div></td></tr>') + '</tbody></table></div></div>';
    $('ep-back').addEventListener('click', function(){ endpointActiveId = null; viewEndpoints(el); });
    $('ep-test').addEventListener('click', function(){ testEndpointButton(this, id, el); });
    if ($('ep-delete')) $('ep-delete').addEventListener('click', function(){ if (confirm('确定删除这个自定义接口？历史情报不会被删除。')) apiDelete('/api/admin/endpoints/' + encodeURIComponent(id)).then(function(){ toast('接口已删除'); endpointActiveId = null; viewEndpoints(el); }).catch(function(err){ toast(err.message || '删除失败','err'); }); });
    $('ep-save').addEventListener('click', function(){
      var btn = this; btn.disabled = true;
      var payload = {
        name: $('ep-name').value.trim(), description: $('ep-description').value,
        url: $('ep-url').value.trim(), enabled: $('ep-enabled').checked,
        timeoutMs: Number($('ep-timeout').value), retries: Number($('ep-retries').value),
      };
      if ($('ep-publish')) payload.publishMode = $('ep-publish').value;
      if (item.custom) Object.assign(payload, { format:$('ep-format').value, itemsPath:$('ep-items-path').value.trim(), titlePath:$('ep-title-path').value.trim(), summaryPath:$('ep-summary-path').value.trim(), urlPath:$('ep-url-path').value.trim(), datePath:$('ep-date-path').value.trim(), sourceName:item.sourceName, category:item.category, maxItems:item.maxItems });
      apiPatch('/api/admin/endpoints/' + encodeURIComponent(id), payload).then(function(){ toast('接口设置已保存'); viewEndpointDetail(el, id); })
        .catch(function(err){ toast(err.message || '保存失败', 'err'); })
        .finally(function(){ btn.disabled = false; });
    });
  }).catch(function(err){ if (err.status !== 401) el.innerHTML = '<div class="banner warn"><span>⚠</span><div>加载失败：' + esc(err.message || '未知错误') + '</div></div>'; });
}

// ================= 视图：采集日志 =================
var logDate = null, logLines = 200;
function viewLogs(el){
  loadViewSpinner(el);
  apiGet('/api/admin/logs?date=' + (logDate || '') + '&lines=' + logLines).then(function(r){
    if (!logDate) logDate = r.date;
    var dates = r.dates || [];
    var html = '' +
      '<div class="toolbar-row">' +
        '<select id="log-date">' + dates.map(function(d){ return '<option value="' + d + '"' + (d === r.date ? ' selected' : '') + '>' + d + '</option>'; }).join('') + '</select>' +
        '<select id="log-lines">' + [100, 200, 500, 1000].map(function(n){ return '<option value="' + n + '"' + (n === logLines ? ' selected' : '') + '>最近 ' + n + ' 行</option>'; }).join('') + '</select>' +
        '<button class="btn" id="log-load">加载</button>' +
        '<span class="spacer"></span>' +
        '<span style="font-size:12px;color:var(--text-3)">日志同时保存在服务器 data/logs/ 目录，可长期追溯</span>' +
      '</div>';
    if (!r.exists) {
      html += '<div class="card"><div class="empty-tip">该日期暂无日志' + (dates.length ? '（可切换其它日期）' : '（等待首次采集后生成）') + '</div></div>';
    } else {
      var escd = r.lines.map(function(l){
        var cls = '';
        if (l.indexOf('成功') !== -1 || l.indexOf('启动') !== -1 || l.indexOf('登录成功') !== -1) cls = 'ok-line';
        else if (l.indexOf('失败') !== -1 || l.indexOf('异常') !== -1 || l.indexOf('登录失败') !== -1) cls = 'fail-line';
        return '<span class="' + cls + '">' + esc(l) + '</span>';
      }).join('\n') || '（空）';
      html += '<div class="card"><pre class="log-pre" id="log-pre">' + escd + '</pre></div>';
    }
    el.innerHTML = html;
    $('log-date').addEventListener('change', function(){ logDate = this.value; });
    $('log-lines').addEventListener('change', function(){ logLines = Number(this.value); });
    $('log-load').addEventListener('click', function(){ viewLogs(el); });
    var pre = $('log-pre');
    if (pre) pre.scrollTop = pre.scrollHeight;
  }).catch(function(err){
    if (err.status !== 401) el.innerHTML = '<div class="banner warn"><span>⚠</span><div>加载失败：' + esc(err.message || '未知错误') + '</div></div>';
  });
}

// ================= 视图：友链管理 =================
var friendEditingId = null;
function viewFriendLinks(el){
  loadViewSpinner(el);
  apiGet('/api/admin/friend-links').then(function(r){
    var items = r.items || [], summary = r.summary || {}, editing = friendEditingId ? items.find(function(item){ return item.id === friendEditingId; }) : null;
    if (friendEditingId && !editing) friendEditingId = null;
    var formItem = editing || { name:'', url:'', description:'', sort:(items.length + 1) * 10, enabled:true };
    var rows = items.map(function(item){
      return '<tr>' +
        '<td class="num-c"><b>' + esc(item.sort) + '</b></td>' +
        '<td><b>' + esc(item.name) + '</b>' + (item.description ? '<div class="hint">' + esc(item.description) + '</div>' : '') + '</td>' +
        '<td class="mono" style="max-width:340px;word-break:break-all"><a href="' + esc(item.url) + '" target="_blank" rel="noopener">' + esc(item.url) + ' ↗</a></td>' +
        '<td>' + (item.enabled ? '<span class="tag ok">展示中</span>' : '<span class="tag mut">已停用</span>') + '</td>' +
        '<td style="white-space:nowrap"><button class="btn sm" data-friend-act="edit" data-id="' + esc(item.id) + '">编辑</button> ' +
          '<button class="btn sm" data-friend-act="toggle" data-enabled="' + (item.enabled ? '1' : '0') + '" data-id="' + esc(item.id) + '">' + (item.enabled ? '停用' : '启用') + '</button> ' +
          '<button class="btn sm danger" data-friend-act="delete" data-id="' + esc(item.id) + '" data-name="' + esc(item.name) + '">删除</button></td>' +
      '</tr>';
    }).join('') || '<tr><td colspan="5"><div class="empty-tip">还没有友链，请使用上方表单添加。</div></td></tr>';
    el.innerHTML = '' +
      '<div class="kpi-grid">' + kpi('友链总数', fmtNum(summary.total || 0), '全部已保存链接') + kpi('前台展示', fmtNum(summary.enabled || 0), '当前启用', 'good') + kpi('已停用', fmtNum(summary.disabled || 0), '保留但不展示', 'warn') + '</div>' +
      '<div class="card"><h3><span class="bar"></span>' + (editing ? '编辑友链' : '添加友链') + '<span class="right">保存后刷新前台即可看到；排序数字越小越靠前</span></h3>' +
        '<div class="form-row"><div><label>友链名称</label><input id="friend-name" type="text" maxlength="60" style="width:100%" placeholder="例如：AI 工具导航" value="' + esc(formItem.name) + '"></div>' +
        '<div><label>链接地址</label><input id="friend-url" type="text" maxlength="2000" style="width:100%" placeholder="https://example.com/" value="' + esc(formItem.url) + '"></div></div>' +
        '<div class="form-row" style="margin-top:12px"><div><label>简短说明 <span class="hint">（可留空）</span></label><input id="friend-description" type="text" maxlength="160" style="width:100%" placeholder="鼠标悬停时显示" value="' + esc(formItem.description) + '"></div>' +
        '<div><label>排序</label><input id="friend-sort" type="number" min="-9999" max="9999" step="1" style="width:100%" value="' + esc(formItem.sort) + '"></div></div>' +
        '<div class="check-row" style="margin-top:12px"><label><input id="friend-enabled" type="checkbox"' + (formItem.enabled !== false ? ' checked' : '') + '> 在前台展示</label></div>' +
        '<div class="form-actions"><button class="btn btn-solid" id="friend-save">' + (editing ? '保存修改' : '添加友链') + '</button>' + (editing ? '<button class="btn" id="friend-cancel">取消编辑</button>' : '') + '</div>' +
      '</div>' +
      '<div class="card"><h3><span class="bar"></span>友链列表<span class="right">支持查看、编辑、启停与删除</span></h3><div class="tbl-wrap"><table class="tbl"><thead><tr><th class="num-c">排序</th><th>名称与说明</th><th>链接地址</th><th>状态</th><th>操作</th></tr></thead><tbody>' + rows + '</tbody></table></div></div>';
    $('friend-save').addEventListener('click', function(){
      var payload = { name:$('friend-name').value.trim(), url:$('friend-url').value.trim(), description:$('friend-description').value.trim(), sort:Number($('friend-sort').value), enabled:$('friend-enabled').checked };
      if (!payload.name || !payload.url) { toast('请填写友链名称和链接地址', 'err'); return; }
      var btn = this; btn.disabled = true;
      (editing ? apiPatch('/api/admin/friend-links/' + encodeURIComponent(editing.id), payload) : apiPost('/api/admin/friend-links', payload))
        .then(function(){ toast(editing ? '友链已更新' : '友链已添加'); friendEditingId = null; viewFriendLinks(el); })
        .catch(function(err){ toast(err.message || '保存失败', 'err'); btn.disabled = false; });
    });
    if ($('friend-cancel')) $('friend-cancel').addEventListener('click', function(){ friendEditingId = null; viewFriendLinks(el); });
    el.querySelectorAll('[data-friend-act]').forEach(function(btn){
      btn.addEventListener('click', function(){
        var id = btn.getAttribute('data-id'), act = btn.getAttribute('data-friend-act');
        if (act === 'edit') { friendEditingId = id; viewFriendLinks(el); return; }
        if (act === 'toggle') {
          apiPatch('/api/admin/friend-links/' + encodeURIComponent(id), { enabled:btn.getAttribute('data-enabled') !== '1' })
            .then(function(){ toast('展示状态已更新'); viewFriendLinks(el); }).catch(function(err){ toast(err.message || '更新失败', 'err'); });
          return;
        }
        if (act === 'delete' && confirm('确定删除友链“' + (btn.getAttribute('data-name') || '') + '”？删除后不可恢复。')) {
          apiDelete('/api/admin/friend-links/' + encodeURIComponent(id)).then(function(){ toast('友链已删除'); if (friendEditingId === id) friendEditingId = null; viewFriendLinks(el); })
            .catch(function(err){ toast(err.message || '删除失败', 'err'); });
        }
      });
    });
  }).catch(function(err){ if (err.status !== 401) el.innerHTML = '<div class="banner warn"><span>⚠</span><div>加载失败：' + esc(err.message || '未知错误') + '</div></div>'; });
}

// ================= 视图：邮箱管理 =================
function viewEmail(el){
  loadViewSpinner(el);
  apiGet('/api/admin/email').then(function(r){
    var s = r.settings || {}, summary = r.summary || {}, rules = s.rules || {};
    var logs = (r.logs || []).map(function(row){
      return '<tr><td title="' + esc(row.at) + '">' + esc(fmtTime(row.at)) + '</td><td>' + (row.status === 'sent' ? '<span class="tag ok">已发送</span>' : '<span class="tag fail">失败</span>') + '</td><td>' + esc(row.kind || 'manual') + '</td><td title="' + esc(row.subject || '') + '">' + esc(String(row.subject || '').slice(0,60)) + '</td><td>' + esc((row.recipients || []).join('、')) + '</td><td class="num-c">' + (row.durationMs != null ? fmtMs(row.durationMs) : '—') + '</td><td title="' + esc(row.error || '') + '">' + esc(row.error ? String(row.error).slice(0,60) : '—') + '</td></tr>';
    }).join('') || '<tr><td colspan="7"><div class="empty-tip">还没有邮件发送记录</div></td></tr>';
    var last = summary.last || null;
    el.innerHTML = '' +
      '<div class="kpi-grid">' +
        kpi('邮件服务', summary.enabled ? '已启用' : summary.configured ? '已配置' : '未配置', summary.enabled ? '自动通知已生效' : '默认不会自动发送', summary.enabled ? 'good' : 'warn') +
        kpi('管理员收件人', fmtNum(summary.recipients), '最多支持 20 个', 'teal') +
        kpi('最近成功', fmtNum(summary.sent), '最近 50 条发送记录', 'good') +
        kpi('最近失败', fmtNum(summary.failed), last ? '最后活动 ' + esc(fmtDateShort(last.at)) : '暂无活动', summary.failed ? 'warn' : '') +
      '</div>' +
      '<div class="banner info"><span>🔐</span><div>SMTP 密码或授权码使用服务器独立密钥进行 AES-256-GCM 加密，后台接口不会回传明文。邮件服务默认关闭；只有保存并启用通知规则后才会自动发送。</div></div>' +
      '<div class="card"><h3><span class="bar"></span>SMTP 发信配置<span class="right">支持 SSL/TLS 与 STARTTLS</span></h3>' +
        '<div class="toolbar-row"><span class="hint">快捷预设：</span><button class="btn sm" data-email-preset="qq">QQ 邮箱</button><button class="btn sm" data-email-preset="163">163 邮箱</button><button class="btn sm" data-email-preset="gmail">Gmail</button><button class="btn sm" data-email-preset="outlook">Outlook</button></div>' +
        '<div class="check-row" style="margin-bottom:14px"><label><input type="checkbox" id="email-enabled"' + (s.enabled ? ' checked' : '') + ' /> 启用邮件服务与自动通知</label></div>' +
        '<div class="form-row"><div class="field"><label>服务商备注</label><input id="email-provider" type="text" maxlength="100" style="width:100%" value="' + esc(s.providerName || '') + '" placeholder="例如：QQ 企业邮箱" /></div>' +
          '<div class="field"><label>SMTP 主机</label><input id="email-host" type="text" maxlength="253" style="width:100%" value="' + esc(s.host || '') + '" placeholder="smtp.example.com" /></div></div>' +
        '<div class="form-row"><div class="field"><label>端口</label><select id="email-port" style="width:100%"><option value="465"' + (Number(s.port) === 465 ? ' selected' : '') + '>465</option><option value="587"' + (Number(s.port) === 587 ? ' selected' : '') + '>587</option><option value="2525"' + (Number(s.port) === 2525 ? ' selected' : '') + '>2525</option></select></div>' +
          '<div class="field"><label>连接安全</label><select id="email-security" style="width:100%"><option value="tls"' + (s.security !== 'starttls' ? ' selected' : '') + '>SSL/TLS（通常 465）</option><option value="starttls"' + (s.security === 'starttls' ? ' selected' : '') + '>STARTTLS（通常 587/2525）</option></select></div></div>' +
        '<div class="form-row"><div class="field"><label>SMTP 登录账号</label><input id="email-username" type="text" maxlength="320" autocomplete="username" style="width:100%" value="' + esc(s.username || '') + '" placeholder="通常填写完整邮箱地址" /></div>' +
          '<div class="field"><label>SMTP 密码 / 授权码</label><input id="email-password" type="password" maxlength="500" autocomplete="new-password" style="width:100%" placeholder="' + (s.hasPassword ? '已加密保存，留空表示不修改' : '请输入邮箱授权码或 SMTP 密码') + '" /><div class="hint">' + esc(s.passwordHint || '尚未设置') + '；建议使用邮箱服务商生成的独立授权码。</div></div></div>' +
        '<div class="check-row" style="margin:-4px 0 14px"><label><input type="checkbox" id="email-clear-password" /> 清除服务器中已保存的 SMTP 密码</label></div>' +
        '<div class="form-row"><div class="field"><label>发件人名称</label><input id="email-from-name" type="text" maxlength="100" style="width:100%" value="' + esc(s.fromName || 'AI圈报') + '" /></div>' +
          '<div class="field"><label>发件邮箱</label><input id="email-from-address" type="email" maxlength="320" style="width:100%" value="' + esc(s.fromAddress || '') + '" placeholder="notice@example.com" /></div></div>' +
        '<div class="field"><label>回复邮箱（可选）</label><input id="email-reply-to" type="email" maxlength="320" style="width:100%" value="' + esc(s.replyTo || '') + '" placeholder="留空则回复发件邮箱" /></div>' +
        '<div class="field"><label>管理员收件人</label><textarea id="email-recipients" rows="3" maxlength="6500" placeholder="每行一个邮箱，也可用逗号分隔">' + esc((s.recipients || []).join('\n')) + '</textarea><div class="hint">采集异常通知会发送给这里的邮箱，最多 20 个。</div></div>' +
        '<div class="card" style="box-shadow:none;background:var(--surface-2);margin:14px 0"><h3><span class="bar"></span>自动通知规则</h3><div class="check-row"><label><input type="checkbox" id="email-rule-failure"' + (rules.collectFailure ? ' checked' : '') + ' /> 采集失败时通知（同类错误 1 小时内最多一次）</label><label><input type="checkbox" id="email-rule-recovery"' + (rules.collectRecovery ? ' checked' : '') + ' /> 采集从失败恢复时通知</label></div></div>' +
        '<div class="form-actions"><button class="btn btn-solid" id="email-save">保存邮箱设置</button></div>' +
      '</div>' +
      '<div class="card"><h3><span class="bar"></span>发送测试邮件<span class="right">先保存当前表单，再执行真实 SMTP 测试</span></h3>' +
        '<div class="form-row"><div class="field"><label>测试收件邮箱</label><input id="email-test-recipient" type="email" maxlength="320" style="width:100%" value="' + esc((s.recipients || [])[0] || '') + '" placeholder="your@example.com" /></div><div class="field"><label>测试说明</label><div class="hint" style="padding-top:9px">点击后会真实发送一封测试邮件，并将成功或失败原因写入下方日志。</div></div></div>' +
        '<div class="form-actions"><button class="btn" id="email-test">保存并发送测试邮件</button></div>' +
      '</div>' +
      '<div class="card"><h3><span class="bar"></span>常用服务商参数<span class="right">使用邮箱后台生成的授权码</span></h3><div class="tbl-wrap"><table class="tbl"><thead><tr><th>服务商</th><th>SMTP 主机</th><th class="num-c">端口</th><th>安全方式</th></tr></thead><tbody><tr><td>QQ 邮箱</td><td class="mono">smtp.qq.com</td><td class="num-c">465</td><td>SSL/TLS</td></tr><tr><td>163 邮箱</td><td class="mono">smtp.163.com</td><td class="num-c">465</td><td>SSL/TLS</td></tr><tr><td>Gmail</td><td class="mono">smtp.gmail.com</td><td class="num-c">465</td><td>SSL/TLS · 应用专用密码</td></tr><tr><td>Outlook / Microsoft 365</td><td class="mono">smtp.office365.com</td><td class="num-c">587</td><td>STARTTLS</td></tr></tbody></table></div></div>' +
      '<div class="card"><h3><span class="bar"></span>邮件发送日志<span class="right">最多保留最近 500 条，收件地址脱敏显示</span></h3><div class="tbl-wrap"><table class="tbl"><thead><tr><th>时间</th><th>状态</th><th>类型</th><th>主题</th><th>收件人</th><th class="num-c">耗时</th><th>结果</th></tr></thead><tbody>' + logs + '</tbody></table></div></div>';

    var presets = {
      qq:{provider:'QQ 邮箱',host:'smtp.qq.com',port:'465',security:'tls'},
      '163':{provider:'163 邮箱',host:'smtp.163.com',port:'465',security:'tls'},
      gmail:{provider:'Gmail',host:'smtp.gmail.com',port:'465',security:'tls'},
      outlook:{provider:'Outlook / Microsoft 365',host:'smtp.office365.com',port:'587',security:'starttls'}
    };
    el.querySelectorAll('[data-email-preset]').forEach(function(button){ button.addEventListener('click', function(){ var p=presets[button.getAttribute('data-email-preset')]; $('email-provider').value=p.provider; $('email-host').value=p.host; $('email-port').value=p.port; $('email-security').value=p.security; toast('已填入 ' + p.provider + ' SMTP 参数','info'); }); });
    $('email-port').addEventListener('change', function(){ $('email-security').value = this.value === '465' ? 'tls' : 'starttls'; });
    var payload = function(){ return {
      enabled:$('email-enabled').checked, providerName:$('email-provider').value.trim(), host:$('email-host').value.trim(), port:Number($('email-port').value), security:$('email-security').value,
      username:$('email-username').value.trim(), password:$('email-password').value, clearPassword:$('email-clear-password').checked,
      fromName:$('email-from-name').value.trim(), fromAddress:$('email-from-address').value.trim(), replyTo:$('email-reply-to').value.trim(), recipients:$('email-recipients').value,
      rules:{collectFailure:$('email-rule-failure').checked,collectRecovery:$('email-rule-recovery').checked}
    }; };
    $('email-save').addEventListener('click', function(){ var button=this; button.disabled=true; apiPost('/api/admin/email/settings',payload()).then(function(){ toast('邮箱设置已加密保存'); viewEmail(el); }).catch(function(err){ toast(err.message || '保存失败','err'); button.disabled=false; }); });
    $('email-test').addEventListener('click', function(){
      var button=this, recipient=$('email-test-recipient').value.trim();
      if (!recipient) { toast('请填写测试收件邮箱','err'); return; }
      button.disabled=true; button.textContent='正在连接 SMTP…';
      apiPost('/api/admin/email/settings',payload()).then(function(){ return apiPost('/api/admin/email/test',{recipient:recipient}); }).then(function(r){ toast('测试邮件发送成功，耗时 ' + fmtMs(r.result.durationMs)); viewEmail(el); }).catch(function(err){ toast(err.message || '测试发送失败','err'); button.disabled=false; button.textContent='保存并发送测试邮件'; });
    });
  }).catch(function(err){ if (err.status !== 401) el.innerHTML = '<div class="banner warn"><span>⚠</span><div>邮箱管理加载失败：' + esc(err.message || '未知错误') + '</div></div>'; });
}

// ================= 视图：SEO 管理 =================
function viewSeo(el){
  loadViewSpinner(el);
  apiGet('/api/admin/seo').then(function(r){
    var s = r.settings || {}, keywordRows = (r.keywords || []).map(function(k){ return '<tr><td><b>' + esc(k.keyword) + '</b></td><td class="num-c">' + fmtNum(k.occurrences) + '</td><td>' + (k.occurrences ? '<span class="tag ok">已有覆盖</span>' : '<span class="tag mut">暂无覆盖</span>') + '</td></tr>'; }).join('');
    var categoryRows = (r.categories || []).map(function(c){ return '<tr><td><a href="' + esc(c.url) + '" target="_blank" rel="noopener">' + esc(c.label) + ' ↗</a></td><td class="num-c">' + fmtNum(c.count) + '</td><td class="mono">/category/' + esc(c.slug) + '</td></tr>'; }).join('');
    el.innerHTML = '' +
      '<div class="kpi-grid">' + kpi('中文可索引文章', fmtNum(r.publishedArticles), '中文主站文章详情页') + kpi('英文可索引文章', fmtNum(r.englishArticles), '/en/ 独立英文内容', 'teal') + kpi('站点地图 URL', fmtNum(r.sitemapUrls), '中英文入口 + 分类 + 文章', 'good') + kpi('目标关键词', fmtNum((r.keywords || []).length), s.indexingEnabled ? '允许搜索引擎收录' : '当前全站 noindex', s.indexingEnabled ? 'good' : 'warn') + '</div>' +
      '<div class="card"><h3><span class="bar"></span>网站标题与关键词<span class="right">保存后首页、文章、分类、RSS、Sitemap 同步生效</span></h3>' +
        '<div class="form-row"><div class="field"><label>首页 SEO 标题</label><input id="seo-title" type="text" maxlength="100" style="width:100%" value="' + esc(s.siteTitle) + '" /><div class="hint">用于浏览器标签和首页搜索结果，建议写清主要内容。</div></div><div class="field"><label>品牌名 / 站点名称</label><input id="seo-short" type="text" maxlength="80" style="width:100%" value="' + esc(s.shortTitle) + '" /><div class="hint">用于站内页、RSS 和结构化数据，保持简短统一。</div></div></div>' +
        '<div class="field"><label>网站描述</label><textarea id="seo-description" maxlength="300" rows="3">' + esc(s.description) + '</textarea></div>' +
        '<div class="field"><label>内容主题词</label><textarea id="seo-keywords" maxlength="1000" rows="3">' + esc(s.keywords) + '</textarea><div class="hint">用英文逗号、中文逗号或换行分隔；用于站内内容覆盖统计和部分搜索引擎元数据，不替代真实文章内容。</div></div>' +
        '<div class="banner info"><span>EN</span><div><b>英文版 SEO</b><br>英文入口固定为 <span class="mono">/en/</span>，使用独立 canonical、hreflang、文章归档和 RSS；只收录正文确实以英文为主的情报。</div></div>' +
        '<div class="field"><label>English homepage title</label><input id="seo-en-title" type="text" maxlength="120" style="width:100%" value="' + esc(s.englishTitle) + '" /></div>' +
        '<div class="field"><label>English website description</label><textarea id="seo-en-description" maxlength="320" rows="3">' + esc(s.englishDescription) + '</textarea></div>' +
        '<div class="field"><label>English target keywords</label><textarea id="seo-en-keywords" maxlength="1200" rows="3">' + esc(s.englishKeywords) + '</textarea><div class="hint">Use natural English phrases separated by commas. Rankings still depend on useful English content, crawlability and external signals.</div></div>' +
        '<div class="form-row"><div class="field"><label>主站 HTTPS 根地址（唯一 Canonical）</label><input id="seo-url" type="text" maxlength="300" style="width:100%" value="' + esc(s.siteUrl) + '" /><div class="hint">只能设置一个主站地址；其它域名应永久跳转到这里，避免重复收录和权重分散。</div></div><div class="field"><label>搜索引擎状态</label><div class="check-row" style="padding:9px 0"><label><input id="seo-indexing" type="checkbox"' + (s.indexingEnabled ? ' checked' : '') + ' /> 允许索引与跟踪链接</label></div></div></div>' +
        '<div class="form-actions"><button class="btn btn-solid" id="seo-save">保存 SEO 设置</button><a class="btn" href="' + esc(r.endpoints.english) + '" target="_blank" rel="noopener">查看英文版 ↗</a><a class="btn" href="' + esc(r.endpoints.sitemap) + '" target="_blank" rel="noopener">查看 Sitemap ↗</a><a class="btn" href="' + esc(r.endpoints.rss) + '" target="_blank" rel="noopener">查看 RSS ↗</a><a class="btn" href="' + esc(r.endpoints.robots) + '" target="_blank" rel="noopener">查看 robots.txt ↗</a></div>' +
      '</div>' +
      '<div class="card"><h3><span class="bar"></span>搜索结果预览</h3><div class="snippet"><div class="snippet-title" id="seo-preview-title">' + esc(s.siteTitle) + '</div><div class="snippet-url" id="seo-preview-url">' + esc(s.siteUrl) + '/</div><div class="snippet-desc" id="seo-preview-desc">' + esc(s.description) + '</div></div></div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px" class="two-col"><div class="card"><h3><span class="bar"></span>关键词覆盖统计</h3><div class="tbl-wrap"><table class="tbl"><thead><tr><th>关键词</th><th class="num-c">出现次数</th><th>状态</th></tr></thead><tbody>' + (keywordRows || '<tr><td colspan="3"><div class="empty-tip">暂无关键词</div></td></tr>') + '</tbody></table></div></div><div class="card"><h3><span class="bar"></span>分类页覆盖</h3><div class="tbl-wrap"><table class="tbl"><thead><tr><th>分类</th><th class="num-c">文章</th><th>路径</th></tr></thead><tbody>' + categoryRows + '</tbody></table></div></div></div>';
    var preview = function(){ $('seo-preview-title').textContent = $('seo-title').value || '网站标题'; $('seo-preview-url').textContent = ($('seo-url').value || 'https://example.com').replace(/\/+$/,'') + '/'; $('seo-preview-desc').textContent = $('seo-description').value || '网站描述'; };
    ['seo-title','seo-url','seo-description'].forEach(function(id){ $(id).addEventListener('input', preview); });
    $('seo-save').addEventListener('click', function(){ var btn=this; btn.disabled=true; apiPost('/api/admin/seo', { seoSiteTitle:$('seo-title').value.trim(), seoShortTitle:$('seo-short').value.trim(), seoDescription:$('seo-description').value.trim(), seoKeywords:$('seo-keywords').value.trim(), seoEnglishTitle:$('seo-en-title').value.trim(), seoEnglishDescription:$('seo-en-description').value.trim(), seoEnglishKeywords:$('seo-en-keywords').value.trim(), seoSiteUrl:$('seo-url').value.trim(), seoIndexingEnabled:$('seo-indexing').checked }).then(function(){ toast('中英文 SEO 设置已保存并即时生效'); viewSeo(el); }).catch(function(err){ toast(err.message || '保存失败','err'); }).finally(function(){ btn.disabled=false; }); });
  }).catch(function(err){ if (err.status !== 401) el.innerHTML = '<div class="banner warn"><span>⚠</span><div>加载失败：' + esc(err.message || '未知错误') + '</div></div>'; });
}

// ================= 视图：系统设置 =================
function viewSettings(el){
  loadViewSpinner(el);
  apiGet('/api/admin/settings').then(function(r){
    var cfg = r.config, env = r.env, auth = r.auth;
    var initPwd = auth.initialPasswordPresent
      ? '<div class="banner warn" style="margin-top:10px"><span>⚠</span><div>检测到初始密码文件仍存在（服务器 <span class="mono">data/auth/initial-password.txt</span>）。请尽快修改密码，修改成功后该文件会自动删除。</div></div>'
      : '';
    el.innerHTML = '' +
      '<div class="card"><h3><span class="bar"></span>站点品牌与图标<span class="right">前台、文章、RSS 与 SEO 同步</span></h3>' +
        '<div class="banner info"><span>✦</span><div>统一管理公开站点的显示名称、简称、副标题和图标。站点名称也会同步到 SEO、结构化数据及文章系统；图标支持站内 <span class="mono">/路径</span> 或 HTTPS 地址。</div></div>' +
        '<div class="form-row"><div class="field"><label>站点显示名称</label><input id="set-brand-name" type="text" maxlength="80" style="width:100%" value="' + esc(cfg.seoShortTitle || 'AI圈报') + '" /></div><div class="field"><label>品牌简称 / 英文名</label><input id="set-brand-alias" type="text" maxlength="24" style="width:100%" value="' + esc(cfg.siteBrandAlias || 'AIQB') + '" /></div></div>' +
        '<div class="form-row"><div class="field"><label>中文副标题</label><input id="set-brand-tagline" type="text" maxlength="80" style="width:100%" value="' + esc(cfg.siteTagline || '') + '" /></div><div class="field"><label>英文副标题</label><input id="set-brand-tagline-en" type="text" maxlength="100" style="width:100%" value="' + esc(cfg.siteEnglishTagline || '') + '" /></div></div>' +
        '<div class="form-row"><div class="field"><label>页头 Logo 地址</label><input id="set-brand-logo" type="text" maxlength="500" style="width:100%" value="' + esc(cfg.siteLogoUrl || '/favicon.svg') + '" /><div class="hint">建议使用正方形 SVG、PNG 或 WebP；修改后同步用于文章页与结构化数据。</div></div><div class="field"><label>浏览器 / SEO 图标地址</label><input id="set-brand-favicon" type="text" maxlength="500" style="width:100%" value="' + esc(cfg.siteFaviconUrl || '/favicon.ico') + '" /><div class="hint">建议使用可公开访问的 ICO、PNG 或 SVG，小尺寸下仍应清晰。</div></div></div>' +
        '<div class="brand-live-preview"><img id="set-brand-preview-img" src="' + esc(cfg.siteLogoUrl || '/favicon.svg') + '" alt="品牌图标预览" /><div><b><span id="set-brand-preview-name">' + esc(cfg.seoShortTitle || 'AI圈报') + '</span><span class="alias" id="set-brand-preview-alias">' + esc(cfg.siteBrandAlias || 'AIQB') + '</span></b><span id="set-brand-preview-tagline">' + esc(cfg.siteTagline || '') + '</span></div></div>' +
        '<div class="form-actions"><button class="btn btn-solid" id="set-brand-save">保存品牌设置</button><button class="btn" id="set-brand-reset" type="button">恢复系统默认值</button><a class="btn" href="/" target="_blank" rel="noopener">查看前台 ↗</a></div><div class="ok-msg" id="set-brand-ok"></div>' +
      '</div>' +
      '<div class="card"><h3><span class="bar"></span>前台展示与交互<span class="right">修改后即时生效</span></h3>' +
        '<div class="form-row"><div class="field"><label>新访客默认主题</label><select id="set-default-theme" style="width:100%"><option value="light"' + (cfg.defaultTheme === 'light' ? ' selected' : '') + '>浅色</option><option value="dark"' + (cfg.defaultTheme === 'dark' ? ' selected' : '') + '>深色</option><option value="system"' + (cfg.defaultTheme === 'system' ? ' selected' : '') + '>跟随设备</option></select><div class="hint">只影响尚未手动选择主题的访客，不覆盖用户已保存的偏好。</div></div><div class="field"><label>首页最新情报数量</label><input id="set-home-latest" type="number" min="5" max="20" value="' + Number(cfg.homeLatestCount || 10) + '" /><div class="hint">首页最新情报区域显示 5–20 条，完整内容仍可进入情报页查看。</div></div></div>' +
        '<div class="check-row" style="margin:12px 0"><label><input type="checkbox" id="set-language-switch"' + (cfg.showLanguageSwitcher !== false ? ' checked' : '') + ' /> 显示中英文切换</label><label><input type="checkbox" id="set-status-strip"' + (cfg.showStatusStrip !== false ? ' checked' : '') + ' /> 显示前台数据状态栏</label><label><input type="checkbox" id="set-health-enabled"' + (cfg.healthWidgetEnabled !== false ? ' checked' : '') + ' /> 显示健康悬浮球</label></div>' +
        '<div class="field"><label>健康悬浮球刷新间隔（分钟）</label><input id="set-health-refresh" type="number" min="10" max="60" value="' + Number(cfg.healthWidgetRefreshMinutes || 10) + '" /><div class="hint">10–60 分钟；关闭悬浮球后前台不会请求公开健康接口，也不会产生额外轮询。</div></div>' +
        '<div class="form-actions"><button class="btn btn-solid" id="set-experience-save">保存展示设置</button></div><div class="ok-msg" id="set-experience-ok"></div>' +
      '</div>' +
      '<div class="card"><h3><span class="bar"></span>前台自定义 Header<span class="right">可选 · 留空即不展示</span></h3>' +
        '<div class="banner info"><span>ℹ</span><div>用于在公开看板顶部展示公告、活动说明或弹窗。支持常用安全 HTML；为保护后台会话，脚本、iframe、表单和事件属性会在前台自动过滤。</div></div>' +
        '<div class="form-row"><div class="field"><label>展示状态</label><div class="check-row"><label><input type="checkbox" id="set-header-enabled"' + (cfg.customHeaderEnabled ? ' checked' : '') + ' /> 启用自定义内容</label></div></div>' +
          '<div class="field"><label>展示方式</label><select id="set-header-mode" style="width:100%"><option value="banner"' + (cfg.customHeaderMode !== 'popup' ? ' selected' : '') + '>顶部横幅</option><option value="popup"' + (cfg.customHeaderMode === 'popup' ? ' selected' : '') + '>居中弹窗（每个版本每次会话一次）</option></select></div></div>' +
        '<div class="field"><label>自定义 HTML 内容</label><textarea id="set-header-code" maxlength="20000" rows="8" placeholder="例如：&lt;h3&gt;网站公告&lt;/h3&gt;&lt;p&gt;这里填写公告内容&lt;/p&gt;">' + esc(cfg.customHeaderCode || '') + '</textarea><div class="hint"><span id="set-header-count">' + String(cfg.customHeaderCode || '').length + '</span> / 20000 字符 · 留空或关闭开关时，前台保持正常显示。</div></div>' +
        '<div class="form-actions"><button class="btn btn-solid" id="set-header-save">保存 Header 设置</button><button class="btn" id="set-header-preview-btn">安全预览</button></div>' +
        '<div class="ok-msg" id="set-header-ok"></div><div class="header-preview" id="set-header-preview"><div class="empty-tip">点击“安全预览”查看内容效果；预览沙箱不会运行脚本。</div></div>' +
      '</div>' +
      '<div class="card"><h3><span class="bar"></span>页脚与版权信息<span class="right">前台、文章页同步生效</span></h3>' +
        '<div class="banner info"><span>ℹ</span><div>用于展示可配置的版权和 ICP 备案信息。项目来源署名依据开源协议固定保留，不受此开关影响，也不能被移除或隐藏。</div></div>' +
        '<div class="check-row" style="margin-bottom:12px"><label><input type="checkbox" id="set-footer-enabled"' + (cfg.footerEnabled !== false ? ' checked' : '') + ' /> 显示自定义版权与备案信息</label></div>' +
        '<div class="form-row"><div class="field"><label>版权文字</label><input id="set-footer-copyright" type="text" maxlength="160" style="width:100%" value="' + esc(cfg.footerCopyrightText || '') + '" placeholder="2025–2026 Copyright © AI圈报" /></div>' +
          '<div class="field"><label>ICP备案号</label><input id="set-footer-icp" type="text" maxlength="100" style="width:100%" value="' + esc(cfg.footerIcpNumber || '') + '" placeholder="粤ICP备2025432484号" /></div></div>' +
        '<div class="field"><label>备案查询链接</label><input id="set-footer-icp-url" type="url" maxlength="500" style="width:100%" value="' + esc(cfg.footerIcpUrl || '') + '" placeholder="https://beian.miit.gov.cn/" /><div class="hint">仅允许 HTTPS 地址；备案号留空时只显示版权文字。</div></div>' +
        '<div class="form-actions"><button class="btn btn-solid" id="set-footer-save">保存页脚设置</button></div><div class="ok-msg" id="set-footer-ok"></div>' +
      '</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px" class="two-col">' +
        '<div>' +
          '<div class="card"><h3><span class="bar"></span>账号信息</h3>' +
            '<table class="tbl"><tbody>' +
              '<tr><td style="color:var(--text-3)">当前用户名</td><td><b>' + esc(auth.username) + '</b></td></tr>' +
              '<tr><td style="color:var(--text-3)">账号创建</td><td>' + esc(fmtTime(auth.createdAt)) + '</td></tr>' +
              '<tr><td style="color:var(--text-3)">最近登录</td><td>' + esc(fmtTime(auth.lastLoginAt)) + '</td></tr>' +
            '</tbody></table>' + initPwd +
          '</div>' +
          '<div class="card"><h3><span class="bar"></span>修改用户名</h3>' +
            '<div class="field"><label>新用户名</label><input type="text" id="set-new-user" placeholder="3–32 位字母 / 数字 / _ / -" maxlength="32" /></div>' +
            '<div class="field"><label>当前密码（验证身份）</label><input type="password" id="set-user-pass" placeholder="输入当前密码" /></div>' +
            '<div class="form-actions"><button class="btn btn-solid" id="set-user-btn">保存用户名</button></div>' +
            '<div class="ok-msg" id="set-user-ok"></div>' +
          '</div>' +
          '<div class="card"><h3><span class="bar"></span>修改密码</h3>' +
            '<div class="form-row">' +
              '<div class="field"><label>新密码</label><input type="password" id="set-pass-1" placeholder="至少 8 位" /></div>' +
              '<div class="field"><label>确认新密码</label><input type="password" id="set-pass-2" placeholder="再次输入新密码" /></div>' +
            '</div>' +
            '<div class="field"><label>当前密码（验证身份）</label><input type="password" id="set-pass-cur" placeholder="输入当前密码" /></div>' +
            '<div class="form-actions"><button class="btn btn-solid" id="set-pass-btn">保存密码</button></div>' +
            '<div class="hint">修改密码后，其它设备上的登录会话将全部失效。</div>' +
            '<div class="ok-msg" id="set-pass-ok"></div>' +
          '</div>' +
        '</div>' +
        '<div>' +
          '<div class="card"><h3><span class="bar"></span>运行参数</h3>' +
            '<div class="form-row">' +
              '<div class="field"><label>自动采集间隔（小时）</label><input type="number" id="set-interval" min="1" max="168" value="' + cfg.collectIntervalHours + '" /><div class="hint">1–168 小时，修改后立即生效</div></div>' +
              '<div class="field"><label>快照保留天数</label><input type="number" id="set-retention" min="0" max="3650" value="' + cfg.retentionDays + '" /><div class="hint">0 = 永久保留全部历史快照</div></div>' +
            '</div>' +
            '<div class="field"><label>后台会话有效期（小时）</label><input type="number" id="set-session" min="1" max="720" value="' + cfg.sessionTtlHours + '" /><div class="hint">登录状态保持时长，1–720 小时</div></div>' +
            '<div class="form-actions"><button class="btn btn-solid" id="set-cfg-btn">保存参数</button></div>' +
            '<div class="ok-msg" id="set-cfg-ok"></div>' +
          '</div>' +
          '<div class="card"><h3><span class="bar"></span>服务信息<span class="right">只读</span></h3>' +
            '<table class="tbl"><tbody>' +
              '<tr><td style="color:var(--text-3)">后端版本</td><td>v' + esc(env.version) + '</td></tr>' +
              '<tr><td style="color:var(--text-3)">Node.js</td><td>' + esc(env.nodeVersion) + ' · ' + esc(env.platform) + '</td></tr>' +
              '<tr><td style="color:var(--text-3)">进程 PID</td><td class="mono">' + env.pid + '</td></tr>' +
              '<tr><td style="color:var(--text-3)">启动时间</td><td>' + esc(fmtTime(env.startedAt)) + '（已运行 ' + fmtDur(env.uptimeSec) + '）</td></tr>' +
              '<tr><td style="color:var(--text-3)">监听端口</td><td class="mono">' + env.port + '（' + esc(env.host) + '）</td></tr>' +
              '<tr><td style="color:var(--text-3)">数据目录</td><td class="mono" style="word-break:break-all">' + esc(env.dataDir) + '</td></tr>' +
              '<tr><td style="color:var(--text-3)">内存占用</td><td>RSS ' + env.memoryMB.rss + ' MB · 堆 ' + env.memoryMB.heap + ' MB</td></tr>' +
            '</tbody></table>' +
          '</div>' +
          '<div class="card"><h3><span class="bar"></span>退出登录</h3>' +
            '<div class="hint" style="margin:0 0 10px">退出当前浏览器的登录状态。</div>' +
            '<button class="btn danger" id="set-logout">退出登录</button>' +
          '</div>' +
        '</div>' +
      '</div>';

    var bindOk = function(id, msg){ var n = $(id); n.textContent = msg; n.classList.add('show'); setTimeout(function(){ n.classList.remove('show'); }, 4000); };

    var brandPreview = function(){
      $('set-brand-preview-name').textContent = $('set-brand-name').value.trim() || '站点名称';
      $('set-brand-preview-alias').textContent = $('set-brand-alias').value.trim() || '简称';
      $('set-brand-preview-tagline').textContent = $('set-brand-tagline').value.trim() || '站点副标题';
      $('set-brand-preview-img').src = $('set-brand-logo').value.trim() || '/favicon.svg';
    };
    ['set-brand-name','set-brand-alias','set-brand-tagline','set-brand-logo'].forEach(function(id){ $(id).addEventListener('input', brandPreview); });
    $('set-brand-preview-img').addEventListener('error', function(){ if (!/\/favicon\.svg(?:\?|$)/.test(this.src)) this.src = '/favicon.svg'; });
    $('set-brand-reset').addEventListener('click', function(){
      $('set-brand-name').value = 'AI圈报'; $('set-brand-alias').value = 'AIQB';
      $('set-brand-tagline').value = '每天看懂 AI 圈正在发生什么'; $('set-brand-tagline-en').value = 'Understand what is happening in AI, every day';
      $('set-brand-logo').value = '/favicon.svg'; $('set-brand-favicon').value = '/favicon.ico'; brandPreview(); toast('已填入系统默认值，点击保存后生效','info');
    });
    $('set-brand-save').addEventListener('click', function(){
      var btn=this; btn.disabled=true;
      apiPost('/api/admin/settings',{seoShortTitle:$('set-brand-name').value.trim(),siteBrandAlias:$('set-brand-alias').value.trim(),siteTagline:$('set-brand-tagline').value.trim(),siteEnglishTagline:$('set-brand-tagline-en').value.trim(),siteLogoUrl:$('set-brand-logo').value.trim(),siteFaviconUrl:$('set-brand-favicon').value.trim()})
        .then(function(){bindOk('set-brand-ok','品牌与图标已保存并同步到全站');toast('站点品牌设置已保存');return apiGet('/api/site-settings')}).then(applyAdminBrand)
        .catch(function(err){toast(err.message||'保存失败','err')}).finally(function(){btn.disabled=false});
    });
    $('set-experience-save').addEventListener('click', function(){
      var btn=this; btn.disabled=true;
      apiPost('/api/admin/settings',{defaultTheme:$('set-default-theme').value,showLanguageSwitcher:$('set-language-switch').checked,showStatusStrip:$('set-status-strip').checked,healthWidgetEnabled:$('set-health-enabled').checked,healthWidgetRefreshMinutes:Number($('set-health-refresh').value),homeLatestCount:Number($('set-home-latest').value)})
        .then(function(){bindOk('set-experience-ok','前台展示与交互设置已保存');toast('前台展示设置已保存')})
        .catch(function(err){toast(err.message||'保存失败','err')}).finally(function(){btn.disabled=false});
    });

    $('set-header-code').addEventListener('input', function(){ $('set-header-count').textContent = this.value.length; });
    $('set-header-preview-btn').addEventListener('click', function(){
      var iframe = document.createElement('iframe');
      iframe.setAttribute('sandbox', '');
      iframe.setAttribute('title', '自定义 Header 安全预览');
      iframe.srcdoc = '<!doctype html><meta charset="utf-8"><style>body{font:14px/1.7 -apple-system,BlinkMacSystemFont,Segoe UI,PingFang SC,Microsoft YaHei,sans-serif;padding:14px;color:#172033}img{max-width:100%;height:auto}a{color:#0b5cff}</style>' + $('set-header-code').value;
      var preview = $('set-header-preview'); preview.innerHTML = ''; preview.appendChild(iframe);
    });
    $('set-header-save').addEventListener('click', function(){
      var btn = this; btn.disabled = true;
      apiPost('/api/admin/settings', {
        customHeaderEnabled: $('set-header-enabled').checked,
        customHeaderMode: $('set-header-mode').value,
        customHeaderCode: $('set-header-code').value,
      }).then(function(){ bindOk('set-header-ok', 'Header 设置已保存并立即生效'); toast('前台 Header 设置已保存'); })
        .catch(function(err){ toast(err.message || '保存失败','err'); })
        .finally(function(){ btn.disabled = false; });
    });

    $('set-footer-save').addEventListener('click', function(){
      var btn = this; btn.disabled = true;
      apiPost('/api/admin/settings', {
        footerEnabled: $('set-footer-enabled').checked,
        footerCopyrightText: $('set-footer-copyright').value,
        footerIcpNumber: $('set-footer-icp').value,
        footerIcpUrl: $('set-footer-icp-url').value,
      }).then(function(){ bindOk('set-footer-ok', '页脚设置已保存并立即生效'); toast('版权与备案信息已保存'); })
        .catch(function(err){ toast(err.message || '保存失败','err'); })
        .finally(function(){ btn.disabled = false; });
    });

    $('set-user-btn').addEventListener('click', function(){
      var btn = this; btn.disabled = true;
      apiPost('/api/admin/username', { currentPassword: $('set-user-pass').value, newUsername: $('set-new-user').value.trim() })
        .then(function(r){
          App.user = r.user; $('topbar-user').textContent = r.user.username;
          bindOk('set-user-ok', '用户名已修改为 ' + r.user.username);
          $('set-new-user').value = ''; $('set-user-pass').value = '';
          toast('用户名修改成功');
        })
        .catch(function(err){ toast(err.message || '修改失败', 'err'); })
        .finally(function(){ btn.disabled = false; });
    });

    $('set-pass-btn').addEventListener('click', function(){
      var p1 = $('set-pass-1').value, p2 = $('set-pass-2').value;
      if (p1.length < 8) { toast('新密码至少 8 位', 'err'); return; }
      if (p1 !== p2) { toast('两次输入的新密码不一致', 'err'); return; }
      var btn = this; btn.disabled = true;
      apiPost('/api/admin/password', { currentPassword: $('set-pass-cur').value, newPassword: p1 })
        .then(function(){
          bindOk('set-pass-ok', '密码修改成功，其它会话已失效');
          $('set-pass-1').value = ''; $('set-pass-2').value = ''; $('set-pass-cur').value = '';
          toast('密码修改成功');
        })
        .catch(function(err){ toast(err.message || '修改失败', 'err'); })
        .finally(function(){ btn.disabled = false; });
    });

    $('set-cfg-btn').addEventListener('click', function(){
      var btn = this; btn.disabled = true;
      apiPost('/api/admin/settings', {
        collectIntervalHours: Number($('set-interval').value),
        retentionDays: Number($('set-retention').value),
        sessionTtlHours: Number($('set-session').value),
      })
        .then(function(r){
          bindOk('set-cfg-ok', '参数已保存' + (r.changedKeys.length ? '：' + r.changedKeys.join('、') : '（无变化）'));
          toast('运行参数已保存');
        })
        .catch(function(err){ toast(err.message || '保存失败', 'err'); })
        .finally(function(){ btn.disabled = false; });
    });

    $('set-logout').addEventListener('click', doLogout);
  }).catch(function(err){
    if (err.status !== 401) el.innerHTML = '<div class="banner warn"><span>⚠</span><div>加载失败：' + esc(err.message || '未知错误') + '</div></div>';
  });
}

// ================= 视图：在线更新 =================
function updatePhaseText(phase){
  return ({ idle:'尚未更新', queued:'等待执行', downloading:'下载安装包', backing_up:'备份数据与代码', installing:'安装新版本', restarting:'重载服务', completed:'更新完成', failed:'更新失败' })[phase] || phase || '未知';
}
function updatePhaseTag(phase){
  return phase === 'completed' ? 'ok' : phase === 'failed' ? 'fail' : phase === 'idle' ? 'mut' : 'info';
}
function renderUpdateView(el, data){
  var status = data.status || {}, last = status.lastCheck || null;
  var busy = ['queued','downloading','backing_up','installing','restarting'].indexOf(status.phase) !== -1;
  var sourceCards = (data.sources || []).map(function(source){
    var checked = last && last.source === source.id ? last : null;
    var revision = checked && (checked.revisionShort || String(checked.revision || '').slice(0, 12));
    var versionLine = checked ? ('远端 v' + esc(checked.latestVersion) + (revision ? ' · 提交 <span class="mono">' + esc(revision) + '</span>' : '') + (checked.signed ? ' · <b class="update-new">签名有效</b>' : '') + (checked.updateAvailable ? ' · <b class="update-new">发现新版本</b>' : ' · 已是最新版')) : '尚未检查远端版本';
    var action = '<button class="btn sm update-check" data-source="' + esc(source.id) + '"' + (busy ? ' disabled' : '') + '>检查更新</button>';
    if (checked && checked.updateAvailable && checked.revision && checked.signatureKeyId && data.supported && !busy) action += '<button class="btn btn-solid sm update-apply" data-source="' + esc(source.id) + '" data-version="' + esc(checked.latestVersion) + '" data-revision="' + esc(checked.revision) + '" data-key-id="' + esc(checked.signatureKeyId) + '">更新到 v' + esc(checked.latestVersion) + '</button>';
    return '<div class="repo-card"><div class="repo-head"><div class="repo-logo ' + esc(source.id) + '">' + (source.id === 'github' ? 'GH' : '码') + '</div><div><b>' + esc(source.name) + '</b><span>' + esc(source.repo) + ' · ' + esc(source.branch) + '</span></div></div>' +
      '<div class="repo-version">' + versionLine + '</div><div class="repo-actions">' + action + '<a class="btn sm" href="' + esc(source.repositoryUrl) + '" target="_blank" rel="noopener noreferrer">打开仓库 ↗</a></div>' +
      (source.authenticated ? '<small class="repo-auth">已配置只读访问令牌</small>' : '<small>公开仓库可直接检查；私有仓库需在服务器环境变量中配置只读令牌</small>') + '</div>';
  }).join('');
  var safeguards = (data.safeguards || []).map(function(item){ return '<li>' + esc(item) + '</li>'; }).join('');
  var statusDetail = status.message || '尚未执行在线更新';
  el.innerHTML = '' +
    (!data.supported ? '<div class="banner warn"><span>!</span><div><b>当前环境仅支持检查版本</b><br/>在线安装只允许在 Linux 生产服务器执行，避免开发电脑被意外覆盖。</div></div>' : '') +
    '<div class="version-hero"><div><span>当前版本</span><b>AIQB v' + esc(data.system && data.system.version || '—') + '</b><small>更新过程不会覆盖 server/data 运行数据</small></div><div><span class="tag ' + updatePhaseTag(status.phase) + '">' + esc(updatePhaseText(status.phase)) + '</span></div></div>' +
    '<div class="repo-grid">' + sourceCards + '</div>' +
    '<div class="card update-status"><h3><span class="bar"></span>更新状态<span class="right">' + esc(status.updatedAt ? fmtTime(status.updatedAt) : '暂无记录') + '</span></h3>' +
      '<div class="update-progress ' + (busy ? 'running' : '') + '"><i></i></div><b>' + esc(statusDetail) + '</b>' +
      (status.backupDir ? '<div class="hint mono">备份目录：' + esc(status.backupDir) + '</div>' : '') +
      (status.warning ? '<div class="hint" style="color:var(--warn)">' + esc(status.warning) + '</div>' : '') +
      (busy ? '<div class="hint">后台正在执行，页面会自动刷新状态；服务重载期间短暂断开属于正常现象。</div>' : '') + '</div>' +
    '<div class="card"><h3><span class="bar"></span>更新安全机制</h3><ul class="safe-list">' + safeguards + '</ul><div class="hint">为了避免供应链风险，后台不能填写任意下载地址，只能使用服务器预设的 GitHub/Gitee 仓库。私有仓库令牌只保存在环境变量中，不会显示在页面或接口响应里。</div></div>';

  el.querySelectorAll('.update-check').forEach(function(button){
    button.addEventListener('click', function(){
      var source = this.getAttribute('data-source'), btn = this;
      btn.disabled = true; btn.textContent = '检查中…';
      apiPost('/api/admin/update/check', { source: source }).then(function(r){
        toast(r.result.updateAvailable ? ('发现新版本 v' + r.result.latestVersion) : '当前已经是最新版');
        renderUpdateView(el, r.overview);
      }).catch(function(err){ toast(err.message || '检查更新失败', 'err'); btn.disabled = false; btn.textContent = '检查更新'; });
    });
  });
  el.querySelectorAll('.update-apply').forEach(function(button){
    button.addEventListener('click', function(){
      var source = this.getAttribute('data-source'), version = this.getAttribute('data-version'), revision = this.getAttribute('data-revision'), keyId = this.getAttribute('data-key-id');
      if (!window.confirm('确认将 AIQB 更新到 v' + version + '？\n\n提交：' + String(revision || '').slice(0, 12) + '\n签名密钥：' + String(keyId || '') + '\n系统会验证签名与逐文件哈希、备份完整数据与旧代码，并在重载后执行健康检查。')) return;
      var btn = this; btn.disabled = true; btn.textContent = '启动中…';
      apiPost('/api/admin/update/apply', { source: source, expectedVersion: version, expectedRevision: revision, expectedKeyId: keyId }).then(function(){
        toast('更新任务已启动，请勿重复操作', 'info');
        setTimeout(function(){ if (App.view === 'update') viewOnlineUpdate(el); }, 1800);
      }).catch(function(err){ toast(err.message || '启动更新失败', 'err'); btn.disabled = false; btn.textContent = '更新到 v' + version; });
    });
  });
  if (busy) setTimeout(function(){ if (App.view === 'update') viewOnlineUpdate(el, true); }, 3000);
}
function viewOnlineUpdate(el){
  loadViewSpinner(el);
  apiGet('/api/admin/update').then(function(data){ if (App.view === 'update') renderUpdateView(el, data); }).catch(function(err){
    if (err.status !== 401) el.innerHTML = '<div class="banner warn"><span>⚠</span><div>更新信息加载失败：' + esc(err.message || '未知错误') + '</div></div>';
  });
}

// ================= 视图：关于系统 =================
function viewAbout(el){
  loadViewSpinner(el);
  apiGet('/api/admin/about').then(function(data){
    var s = data.system || {}, sourceLinks = (data.sources || []).map(function(source){ return '<a class="about-link" href="' + esc(source.repositoryUrl) + '" target="_blank" rel="noopener noreferrer"><b>' + esc(source.name) + '</b><span>' + esc(source.repositoryUrl) + '</span><i>↗</i></a>'; }).join('');
    var github = s.githubUrl || 'https://github.com/chenfengyimei/AIQB', gitee = s.giteeUrl || 'https://gitee.com/chenfengloveyuri/aiqb', bilibili = s.bilibiliUrl || 'https://space.bilibili.com/508302628', license = s.license || {};
    el.innerHTML = '<div class="about-hero"><div class="about-mark">AI</div><div><span>AI 情报管理系统</span><h2>AIQB <small>v' + esc(s.version || '—') + '</small></h2><p>' + esc(s.description || '') + '</p></div></div>' +
      '<div class="two-col" style="display:grid;grid-template-columns:1fr 1fr;gap:16px">' +
        '<div class="card"><h3><span class="bar"></span>系统信息</h3><div class="health-facts">' +
          healthFact('当前版本', 'v' + (s.version || '—')) + healthFact('作者', s.author || 'chenfeng') + healthFact('Node.js', s.nodeVersion || '—') + healthFact('运行平台', s.platform || '—') + healthFact('服务角色', s.role || '—') + healthFact('本次运行', fmtDur(s.uptimeSec || 0)) + '</div></div>' +
        '<div class="card"><h3><span class="bar"></span>开源项目与作者</h3><p class="hint" style="margin:0 0 12px">通过官方仓库获取代码、版本更新与使用说明，也可以关注作者的哔哩哔哩主页。</p>' + sourceLinks + '<a class="about-link" href="' + esc(bilibili) + '" target="_blank" rel="noopener noreferrer"><b>哔哩哔哩</b><span>chenfeng · UID 508302628</span><i>↗</i></a></div>' +
      '</div>' +
      '<div class="card"><h3><span class="bar"></span>项目说明</h3><p style="font-size:13px;line-height:1.8;color:var(--text-2);margin:0">AIQB 是可自托管的 AI 情报采集、去重、归档、展示与运营管理系统，提供中文/英文前台、文章系统、RSS、SEO、访问统计、接口管理、在线更新和完整后台能力。可以免费用于商业运营或盈利；遵循 ' + esc(license.id || 'CPAL-1.0') + ' 协议时，必须保留前台“设计与开发由 AIQB”来源署名，公开网络部署修改版还需按协议提供对应源码。</p><div class="form-actions"><a class="btn btn-solid" href="' + esc(github) + '" target="_blank" rel="noopener noreferrer">访问 GitHub ↗</a><a class="btn" href="' + esc(gitee) + '" target="_blank" rel="noopener noreferrer">访问 Gitee ↗</a><a class="btn" href="' + esc(license.url || 'https://opensource.org/license/cpal-1.0') + '" target="_blank" rel="noopener noreferrer">查看开源协议 ↗</a></div></div>';
  }).catch(function(err){ if (err.status !== 401) el.innerHTML = '<div class="banner warn"><span>⚠</span><div>系统信息加载失败：' + esc(err.message || '未知错误') + '</div></div>'; });
}

// ================= 登录 / 登出 =================
function doLogout(){
  apiPost('/api/admin/logout').catch(function(){}).finally(function(){
    App.user = null;
    showLogin();
  });
}

// ================= 视图注册与初始化 =================
var VIEWS = {
  overview: viewOverview,
  health: viewHealth,
  visits: viewVisits,
  intelligence: viewIntelligence,
  endpoints: viewEndpoints,
  email: viewEmail,
  seo: viewSeo,
  friendLinks: viewFriendLinks,
  snapshots: viewSnapshots,
  logs: viewLogs,
  settings: viewSettings,
  update: viewOnlineUpdate,
  about: viewAbout,
};

onUnauthorized = function(){ showLogin('会话已过期，请重新登录'); };

document.addEventListener('DOMContentLoaded', function(){
  apiGet('/api/site-settings').then(applyAdminBrand).catch(function(){});
  $('login-pass-toggle').addEventListener('click', function(){
    var input = $('login-pass');
    var show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    this.textContent = show ? '隐藏' : '显示';
    this.setAttribute('aria-label', show ? '隐藏密码' : '显示密码');
    input.focus();
  });

  // 登录表单
  $('login-form').addEventListener('submit', function(e){
    e.preventDefault();
    var btn = $('login-btn');
    btn.disabled = true; btn.textContent = '登录中…';
    $('login-err').classList.remove('show');
    apiPost('/api/admin/login', {
      username: $('login-user').value.trim(),
      password: $('login-pass').value,
    }).then(function(r){
      App.user = r.user;
      $('login-pass').value = '';
      showApp();
      toast('欢迎回来，' + r.user.username);
    }).catch(function(err){
      var e2 = $('login-err');
      e2.textContent = err.message || '登录失败';
      e2.classList.add('show');
    }).finally(function(){
      btn.disabled = false; btn.textContent = '登 录';
    });
  });

  // 侧边栏切换
  $('side-nav').addEventListener('click', function(e){
    var b = e.target.closest('.nav-item');
    if (b) switchView(b.getAttribute('data-view'));
  });

  $('btn-logout-side').addEventListener('click', doLogout);
  $('btn-view-refresh').addEventListener('click', function(){
    var btn = this;
    btn.disabled = true;
    switchView(App.view, true);
    setTimeout(function(){ btn.disabled = false; }, 800);
  });
  $('snap-modal-close').addEventListener('click', function(){ $('snap-modal').classList.remove('show'); });
  $('snap-modal').addEventListener('click', function(e){ if (e.target === this) this.classList.remove('show'); });
  document.addEventListener('keydown', function(e){
    if (e.key === 'Escape') $('snap-modal').classList.remove('show');
  });
  function refreshVisibleView(){
    if (document.hidden || $('app-view').style.display === 'none') return;
    if (Date.now() - App.lastViewRefreshAt < 30000) return;
    switchView(App.view, true);
  }
  window.addEventListener('focus', refreshVisibleView);
  document.addEventListener('visibilitychange', refreshVisibleView);

  // 已有会话则直接进入应用
  apiGet('/api/admin/me').then(function(r){
    App.user = r.user;
    showApp();
  }).catch(function(){
    showLogin();
  });
});

})();
