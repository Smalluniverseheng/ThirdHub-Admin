/* ===== ThirdHub-Admin v1.0 ===== */
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (ts) => ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '-';
const fmtBytes = (n) => { if (!n) return '0 B'; if (n < 0) return '无限'; const u = ['B','KB','MB','GB']; let i = 0; while (n >= 1024 && i < 3) { n /= 1024; i++; } return n.toFixed(1) + ' ' + u[i]; };

let sb = null;
let adminUser = null;

/* ---------- 初始化 ---------- */
function getCfg() {
  return {
    url: localStorage.getItem('adm:sb-url') || '',
    key: localStorage.getItem('adm:sb-key') || '',
  };
}
function ensureCfg() {
  let { url, key } = getCfg();
  if (!url || !key) {
    url = prompt('Supabase URL（如 https://xxx.supabase.co）', url || '');
    if (!url) return false;
    key = prompt('Supabase Anon Key', key || '');
    if (!key) return false;
    localStorage.setItem('adm:sb-url', url.trim());
    localStorage.setItem('adm:sb-key', key.trim());
  }
  sb = window.supabase.createClient(url, key);
  return true;
}

async function boot() {
  if (!ensureCfg()) return;
  const { data } = await sb.auth.getSession();
  if (data.session) {
    const ok = await checkAdmin(data.session.user.id);
    if (ok) return showApp();
  }
  $('#login-view').classList.remove('hidden');
}

async function checkAdmin(uid) {
  const { data } = await sb.from('th_profiles').select('*').eq('id', uid).maybeSingle();
  if (data && data.role === 'admin') { adminUser = data; return true; }
  return false;
}

$('#login-btn').onclick = async () => {
  $('#login-err').textContent = '';
  const email = $('#login-email').value.trim();
  const pwd = $('#login-pwd').value;
  const { data, error } = await sb.auth.signInWithPassword({ email, password: pwd });
  if (error) { $('#login-err').textContent = error.message; return; }
  if (!(await checkAdmin(data.user.id))) {
    $('#login-err').textContent = '该账号不是管理员';
    await sb.auth.signOut();
    return;
  }
  showApp();
};

$('#logout-btn').onclick = async () => { await sb.auth.signOut(); location.reload(); };

function showApp() {
  $('#login-view').classList.add('hidden');
  $('#admin-app').classList.remove('hidden');
  switchModule('dashboard');
}

$$('.nav-item').forEach((b) => b.onclick = () => switchModule(b.dataset.mod));
function switchModule(mod) {
  $$('.nav-item').forEach((b) => b.classList.toggle('on', b.dataset.mod === mod));
  const main = $('#main');
  main.innerHTML = '<div class="page-title">加载中…</div>';
  MODULES[mod](main);
}

/* ---------- 通用弹窗 ---------- */
function dialog(title, bodyHtml) {
  const mask = document.createElement('div');
  mask.className = 'mask';
  mask.innerHTML = `<div class="dialog"><h3>${esc(title)}</h3><div class="dlg-body"></div><div class="dialog-foot"><button class="btn" data-a="cancel">取消</button><button class="btn btn-blue" data-a="ok">确定</button></div></div>`;
  $('.dlg-body', mask).innerHTML = bodyHtml;
  document.body.appendChild(mask);
  return new Promise((resolve) => {
    $('[data-a="cancel"]', mask).onclick = () => { mask.remove(); resolve(null); };
    $('[data-a="ok"]', mask).onclick = () => { mask.remove(); resolve($('.dlg-body', mask)); };
    mask.onclick = (e) => { if (e.target === mask) { mask.remove(); resolve(null); } };
  });
}
function toast(msg) {
  const t = document.createElement('div');
  t.style.cssText = 'position:fixed;bottom:30px;left:50%;transform:translateX(-50%);background:#232838;padding:10px 20px;border-radius:99px;font-size:13px;z-index:200';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2200);
}

/* ==================================================
   模块：仪表盘
================================================== */
async function modDashboard(main) {
  const [users, agents, orders, todayOrders] = await Promise.all([
    sb.from('th_profiles').select('id', { count: 'exact', head: true }),
    sb.from('th_profiles').select('id', { count: 'exact', head: true }).eq('role', 'agent'),
    sb.from('th_orders').select('amount, status, created_at'),
    sb.from('th_orders').select('amount').eq('status', 'paid').gte('created_at', new Date().toISOString().slice(0, 10)),
  ]);
  const paidOrders = (orders.data || []).filter((o) => o.status === 'paid');
  const totalIncome = paidOrders.reduce((s, o) => s + (+o.amount || 0), 0);
  const todayIncome = (todayOrders.data || []).reduce((s, o) => s + (+o.amount || 0), 0);

  main.innerHTML = `
    <div class="page-title">仪表盘</div>
    <div class="stat-grid">
      <div class="stat-card"><div class="num">${users.count ?? 0}</div><div class="lbl">总用户数</div></div>
      <div class="stat-card"><div class="num">${agents.count ?? 0}</div><div class="lbl">代理数</div></div>
      <div class="stat-card"><div class="num">${(todayOrders.data || []).length}</div><div class="lbl">今日订单</div></div>
      <div class="stat-card"><div class="num">¥${todayIncome.toFixed(2)}</div><div class="lbl">今日收入</div></div>
      <div class="stat-card"><div class="num">¥${totalIncome.toFixed(2)}</div><div class="lbl">累计收入</div></div>
    </div>
    <div class="panel"><h3>近 14 天订单趋势</h3><canvas id="chart-orders" height="110"></canvas></div>
    <div class="panel"><h3>用户等级分布</h3><canvas id="chart-levels" height="110"></canvas></div>`;

  // 订单趋势图
  const days = [...Array(14)].map((_, i) => { const d = new Date(Date.now() - (13 - i) * 864e5); return d.toISOString().slice(0, 10); });
  const dayCount = days.map((d) => paidOrders.filter((o) => (o.created_at || '').slice(0, 10) === d).length);
  new Chart($('#chart-orders'), {
    type: 'line',
    data: { labels: days.map((d) => d.slice(5)), datasets: [{ label: '订单数', data: dayCount, borderColor: '#3b5bfd', backgroundColor: 'rgba(59,91,253,.15)', fill: true, tension: .35 }] },
    options: { plugins: { legend: { display: false } }, scales: { x: { ticks: { color: '#6b7186' }, grid: { display: false } }, y: { ticks: { color: '#6b7186' }, grid: { color: 'rgba(255,255,255,.05)' } } } },
  });

  // 等级分布
  const { data: profiles } = await sb.from('th_profiles').select('level');
  const lvCount = {};
  (profiles || []).forEach((p) => lvCount[p.level || 'satellite'] = (lvCount[p.level || 'satellite'] || 0) + 1);
  new Chart($('#chart-levels'), {
    type: 'doughnut',
    data: {
      labels: Object.keys(lvCount),
      datasets: [{ data: Object.values(lvCount), backgroundColor: ['#8c8c96', '#4da3ff', '#3dd68c', '#f5a623', '#b98aff', '#ffd54d'] }],
    },
    options: { plugins: { legend: { labels: { color: '#a8aec2' } } } },
  });
}

/* ==================================================
   模块：用户管理
================================================== */
const LEVEL_OPTS = ['guest', 'satellite', 'planet', 'star', 'galaxy', 'universe'];
const LV_TAG = { guest: 'tag-gray', satellite: 'tag-blue', planet: 'tag-green', star: 'tag-orange', galaxy: 'tag-purple', universe: 'tag-gold' };

async function modUsers(main) {
  main.innerHTML = `
    <div class="page-title">用户管理</div>
    <div class="toolbar"><input id="u-search" placeholder="搜索邮箱 / 昵称"><button class="btn" id="u-reload">刷新</button></div>
    <div class="panel"><table><thead><tr><th>邮箱</th><th>昵称</th><th>等级</th><th>角色</th><th>存储用量</th><th>到期时间</th><th>操作</th></tr></thead><tbody id="u-list"></tbody></table></div>`;

  async function load(kw = '') {
    let q = sb.from('th_profiles').select('*').order('created_at', { ascending: false }).limit(200);
    if (kw) q = q.or(`email.ilike.%${kw}%,nickname.ilike.%${kw}%`);
    const { data } = await q;
    $('#u-list').innerHTML = (data || []).map((u) => `
      <tr>
        <td>${esc(u.email || '-')}</td>
        <td>${esc(u.nickname || '-')}</td>
        <td><span class="tag ${LV_TAG[u.level] || 'tag-gray'}">${esc(u.level)}</span></td>
        <td>${u.role === 'admin' ? '<span class="tag tag-gold">管理员</span>' : u.role === 'agent' ? '<span class="tag tag-blue">代理</span>' : '用户'}</td>
        <td>${fmtBytes(u.storage_used)}</td>
        <td>${u.expire_at ? fmtDate(u.expire_at) : '-'}</td>
        <td><button class="btn btn-sm" data-edit="${u.id}">编辑</button></td>
      </tr>`).join('') || '<tr><td colspan="7" class="muted">暂无用户</td></tr>';

    $$('#u-list [data-edit]').forEach((b) => b.onclick = async () => {
      const u = data.find((x) => x.id === b.dataset.edit);
      const body = await dialog('编辑用户：' + (u.email || ''), `
        <div class="form-row"><label>昵称</label><input id="e-nick" value="${esc(u.nickname || '')}"></div>
        <div class="form-row"><label>会员等级</label><select id="e-level">${LEVEL_OPTS.map((l) => `<option ${u.level === l ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="form-row"><label>角色</label><select id="e-role">
          <option value="user" ${u.role === 'user' ? 'selected' : ''}>用户</option>
          <option value="agent" ${u.role === 'agent' ? 'selected' : ''}>代理</option>
          <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>管理员</option>
        </select></div>
        <div class="form-row"><label>到期时间（留空清除）</label><input id="e-expire" value="${u.expire_at ? u.expire_at.slice(0, 10) : ''}" placeholder="2026-12-31"></div>
      `);
      if (!body) return;
      const patch = {
        nickname: $('#e-nick', body).value.trim(),
        level: $('#e-level', body).value,
        role: $('#e-role', body).value,
        expire_at: $('#e-expire', body).value ? new Date($('#e-expire', body).value).toISOString() : null,
      };
      const { error } = await sb.from('th_profiles').update(patch).eq('id', u.id);
      toast(error ? error.message : '已保存');
      load(kw);
    });
  }
  $('#u-reload').onclick = () => load($('#u-search').value.trim());
  $('#u-search').onkeydown = (e) => { if (e.key === 'Enter') load(e.target.value.trim()); };
  load();
}

/* ==================================================
   模块：代理管理
================================================== */
async function modAgents(main) {
  main.innerHTML = `
    <div class="page-title">代理管理</div>
    <div class="stat-grid" id="ag-stats"></div>
    <div class="panel"><h3>代理列表</h3><table><thead><tr><th>邮箱</th><th>邀请码</th><th>下级数</th><th>累计分润</th><th>操作</th></tr></thead><tbody id="ag-list"></tbody></table></div>
    <div class="panel"><h3>分润记录</h3><table><thead><tr><th>代理</th><th>层级</th><th>比例</th><th>金额</th><th>状态</th><th>时间</th><th>操作</th></tr></thead><tbody id="cm-list"></tbody></table></div>`;

  const { data: agents } = await sb.from('th_profiles').select('*').eq('role', 'agent');
  const { data: commissions } = await sb.from('th_agent_commissions').select('*').order('created_at', { ascending: false }).limit(200);
  const { data: relations } = await sb.from('th_agent_relations').select('*');

  const totalCm = (commissions || []).reduce((s, c) => s + (+c.amount || 0), 0);
  const pending = (commissions || []).filter((c) => c.status === 'pending').reduce((s, c) => s + (+c.amount || 0), 0);
  $('#ag-stats').innerHTML = `
    <div class="stat-card"><div class="num">${(agents || []).length}</div><div class="lbl">代理总数</div></div>
    <div class="stat-card"><div class="num">¥${totalCm.toFixed(2)}</div><div class="lbl">累计分润</div></div>
    <div class="stat-card"><div class="num">¥${pending.toFixed(2)}</div><div class="lbl">待结算</div></div>`;

  $('#ag-list').innerHTML = (agents || []).map((a) => {
    const subs = (relations || []).filter((r) => r.agent_id === a.id).length;
    const cm = (commissions || []).filter((c) => c.agent_id === a.id).reduce((s, c) => s + (+c.amount || 0), 0);
    return `<tr>
      <td>${esc(a.email || '-')}</td>
      <td>${esc(a.invite_code || '-')}</td>
      <td>${subs}</td>
      <td>¥${cm.toFixed(2)}</td>
      <td><button class="btn btn-sm btn-red" data-demote="${a.id}">取消代理</button></td>
    </tr>`;
  }).join('') || '<tr><td colspan="5" class="muted">暂无代理</td></tr>';

  $$('#ag-list [data-demote]').forEach((b) => b.onclick = async () => {
    if (!confirm('确定取消该代理资格？')) return;
    await sb.from('th_profiles').update({ role: 'user' }).eq('id', b.dataset.demote);
    toast('已取消');
    modAgents(main);
  });

  $('#cm-list').innerHTML = (commissions || []).map((c) => `
    <tr>
      <td>${esc((agents || []).find((a) => a.id === c.agent_id)?.email || c.agent_id?.slice(0, 8))}</td>
      <td>${c.level_depth} 级</td>
      <td>${(c.rate * 100).toFixed(0)}%</td>
      <td>¥${(+c.amount).toFixed(2)}</td>
      <td><span class="tag ${c.status === 'settled' ? 'tag-green' : c.status === 'withdrawn' ? 'tag-blue' : 'tag-orange'}">${({ pending: '待结算', settled: '已结算', withdrawn: '已提现' })[c.status]}</span></td>
      <td>${fmtDate(c.created_at)}</td>
      <td>${c.status === 'pending' ? `<button class="btn btn-sm btn-green" data-settle="${c.id}">结算</button>` : ''}</td>
    </tr>`).join('') || '<tr><td colspan="7" class="muted">暂无记录</td></tr>';

  $$('#cm-list [data-settle]').forEach((b) => b.onclick = async () => {
    await sb.from('th_agent_commissions').update({ status: 'settled' }).eq('id', b.dataset.settle);
    toast('已结算');
    modAgents(main);
  });
}

/* ==================================================
   模块：订单管理
================================================== */
async function modOrders(main) {
  main.innerHTML = `
    <div class="page-title">订单管理</div>
    <div class="toolbar">
      <select id="o-filter"><option value="">全部状态</option><option value="paid">已支付</option><option value="pending">待支付</option><option value="refunded">已退款</option></select>
      <button class="btn" id="o-reload">刷新</button>
    </div>
    <div class="panel"><table><thead><tr><th>ID</th><th>用户</th><th>等级</th><th>金额</th><th>状态</th><th>时间</th><th>操作</th></tr></thead><tbody id="o-list"></tbody></table></div>`;

  async function load(status = '') {
    let q = sb.from('th_orders').select('*, th_profiles(email)').order('created_at', { ascending: false }).limit(200);
    if (status) q = q.eq('status', status);
    const { data } = await q;
    $('#o-list').innerHTML = (data || []).map((o) => `
      <tr>
        <td>#${o.id}</td>
        <td>${esc(o.profiles?.email || o.user_id?.slice(0, 8))}</td>
        <td><span class="tag ${LV_TAG[o.level] || 'tag-gray'}">${esc(o.level)}</span></td>
        <td>¥${(+o.amount).toFixed(2)}</td>
        <td><span class="tag ${o.status === 'paid' ? 'tag-green' : o.status === 'refunded' ? 'tag-red' : 'tag-orange'}">${({ paid: '已支付', pending: '待支付', refunded: '已退款' })[o.status]}</span></td>
        <td>${fmtDate(o.created_at)}</td>
        <td>${o.status === 'pending' ? `<button class="btn btn-sm btn-green" data-pay="${o.id}">标记支付</button>` : ''}${o.status === 'paid' ? `<button class="btn btn-sm btn-red" data-refund="${o.id}">退款</button>` : ''}</td>
      </tr>`).join('') || '<tr><td colspan="7" class="muted">暂无订单</td></tr>';

    $$('#o-list [data-pay]').forEach((b) => b.onclick = async () => {
      await sb.from('th_orders').update({ status: 'paid' }).eq('id', b.dataset.pay);
      toast('已标记'); load(status);
    });
    $$('#o-list [data-refund]').forEach((b) => b.onclick = async () => {
      if (!confirm('确定退款？')) return;
      await sb.from('th_orders').update({ status: 'refunded' }).eq('id', b.dataset.refund);
      toast('已退款'); load(status);
    });
  }
  $('#o-reload').onclick = () => load($('#o-filter').value);
  $('#o-filter').onchange = () => load($('#o-filter').value);
  load();
}

/* ==================================================
   模块：卡密管理
================================================== */
function genCard() {
  const seg = () => [...Array(8)].map(() => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');
  return 'TP-' + [seg(), seg(), seg(), seg(), seg(), seg()].join('-');
}

async function modCards(main) {
  main.innerHTML = `
    <div class="page-title">卡密管理</div>
    <div class="toolbar">
      <select id="c-level">${LEVEL_OPTS.filter((l) => l !== 'guest').map((l) => `<option value="${l}">${l}</option>`).join('')}</select>
      <select id="c-type"><option value="month">月卡</option><option value="quarter">季卡</option><option value="year">年卡</option><option value="forever">永久卡</option></select>
      <input id="c-count" type="number" value="10" min="1" max="500" style="width:90px" placeholder="数量">
      <button class="btn btn-blue" id="c-gen">生成卡密</button>
      <button class="btn" id="c-export">导出未使用</button>
    </div>
    <div class="panel"><table><thead><tr><th>卡密</th><th>等级</th><th>类型</th><th>状态</th><th>使用者</th><th>操作</th></tr></thead><tbody id="c-list"></tbody></table></div>`;

  async function load() {
    const { data } = await sb.from('th_card_keys').select('*').order('created_at', { ascending: false }).limit(300);
    $('#c-list').innerHTML = (data || []).map((c) => `
      <tr>
        <td style="font-family:monospace;font-size:12px">${esc(c.card)}</td>
        <td><span class="tag ${LV_TAG[c.level] || 'tag-gray'}">${esc(c.level)}</span></td>
        <td>${({ month: '月卡', quarter: '季卡', year: '年卡', forever: '永久' })[c.card_type]}</td>
        <td>${c.disabled ? '<span class="tag tag-red">已禁用</span>' : c.used_by ? '<span class="tag tag-blue">已使用</span>' : '<span class="tag tag-green">未使用</span>'}</td>
        <td>${c.used_by ? c.used_by.slice(0, 8) : '-'}</td>
        <td>${!c.used_by && !c.disabled ? `<button class="btn btn-sm btn-red" data-dis="${c.id}">禁用</button>` : ''}</td>
      </tr>`).join('') || '<tr><td colspan="6" class="muted">暂无卡密</td></tr>';
    $$('#c-list [data-dis]').forEach((b) => b.onclick = async () => {
      await sb.from('th_card_keys').update({ disabled: true }).eq('id', b.dataset.dis);
      toast('已禁用'); load();
    });
  }

  $('#c-gen').onclick = async () => {
    const level = $('#c-level').value;
    const type = $('#c-type').value;
    const count = Math.min(500, Math.max(1, +$('#c-count').value || 1));
    const rows = [...Array(count)].map(() => ({ card: genCard(), level, card_type: type }));
    const { error } = await sb.from('th_card_keys').insert(rows);
    toast(error ? error.message : `已生成 ${count} 张卡密`);
    load();
  };

  $('#c-export').onclick = async () => {
    const { data } = await sb.from('th_card_keys').select('card, level, card_type').is('used_by', null).eq('disabled', false);
    const text = (data || []).map((c) => `${c.card}  ${c.level}  ${c.card_type}`).join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'cards-' + new Date().toISOString().slice(0, 10) + '.txt';
    a.click();
  };

  load();
}

/* ==================================================
   模块：系统更新推送
================================================== */
async function modUpdates(main) {
  main.innerHTML = `
    <div class="page-title">系统更新推送</div>
    <div class="panel"><h3>发布新版本</h3>
      <div class="form-row"><label>版本号（x.y 格式）</label><input id="up-ver" placeholder="1.1"></div>
      <div class="form-row"><label>更新类型</label><select id="up-type"><option value="optional">可选更新</option><option value="force">强制更新</option></select></div>
      <div class="form-row"><label>标题</label><input id="up-title" placeholder="ThirdHub v1.1 更新"></div>
      <div class="form-row"><label>更新内容（每行一条）</label><textarea id="up-content" placeholder="1. 新增…\n2. 修复…"></textarea></div>
      <div class="form-row"><label>下载地址（可选）</label><input id="up-url" placeholder="https://..."></div>
      <button class="btn btn-blue" id="up-publish" style="width:100%">发布推送</button>
    </div>
    <div class="panel"><h3>历史版本</h3><table><thead><tr><th>版本</th><th>类型</th><th>标题</th><th>发布时间</th></tr></thead><tbody id="up-list"></tbody></table></div>`;

  $('#up-publish').onclick = async () => {
    const version = $('#up-ver').value.trim();
    if (!/^\d+\.\d+$/.test(version)) return toast('版本号必须为 x.y 格式');
    const row = {
      version,
      type: $('#up-type').value,
      title: $('#up-title').value.trim() || `ThirdHub v${version} 更新`,
      content: $('#up-content').value.trim(),
      download_url: $('#up-url').value.trim(),
    };
    const { error } = await sb.from('th_app_updates').insert(row);
    toast(error ? error.message : '已发布，客户端启动时将收到推送');
    load();
  };

  async function load() {
    const { data } = await sb.from('th_app_updates').select('*').order('created_at', { ascending: false }).limit(50);
    $('#up-list').innerHTML = (data || []).map((u) => `
      <tr><td>v${esc(u.version)}</td>
      <td><span class="tag ${u.type === 'force' ? 'tag-red' : 'tag-green'}">${u.type === 'force' ? '强制' : '可选'}</span></td>
      <td>${esc(u.title || '')}</td><td>${fmtDate(u.created_at)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">暂无记录</td></tr>';
  }
  load();
}

/* ==================================================
   模块：限时免费模型
================================================== */
async function modFreeModels(main) {
  main.innerHTML = `
    <div class="page-title">限时免费模型</div>
    <div class="panel"><h3>配置</h3>
      <div class="form-row"><label>状态</label><select id="fm-enabled"><option value="true">开启</option><option value="false">关闭</option></select></div>
      <div class="form-row"><label>免费模型列表（每行一个，格式：厂商ID/模型名）</label><textarea id="fm-models" rows="8" placeholder="deepseek/deepseek-chat\nzhipu/glm-4-flash"></textarea></div>
      <div class="form-row"><label>截止时间（留空为不限时）</label><input id="fm-until" placeholder="2026-09-01"></div>
      <div class="form-row"><label>平台代理地址（用户无需 Key 的请求转发端）</label><input id="fm-proxy" placeholder="https://your-worker.workers.dev/free-ai"></div>
      <button class="btn btn-blue" id="fm-save" style="width:100%">保存并下发</button>
    </div>
    <div class="panel"><h3>说明</h3><p class="muted" style="line-height:1.9">开启后，列表中的模型对所有用户免 Key 开放，Token 消耗由平台承担（经平台代理转发）。关闭或到期后用户需自配 API Key。</p></div>`;

  const { data } = await sb.from('th_configs').select('value').eq('key', 'free_models').maybeSingle();
  let cfg = { enabled: false, models: [], until: '', proxy: '' };
  if (data && data.value) { try { cfg = { ...cfg, ...JSON.parse(data.value) }; } catch (e) {} }
  $('#fm-enabled').value = String(!!cfg.enabled);
  $('#fm-models').value = (cfg.models || []).join('\n');
  $('#fm-until').value = cfg.until || '';
  $('#fm-proxy').value = cfg.proxy || '';

  $('#fm-save').onclick = async () => {
    const value = JSON.stringify({
      enabled: $('#fm-enabled').value === 'true',
      models: $('#fm-models').value.split('\n').map((s) => s.trim()).filter(Boolean),
      until: $('#fm-until').value.trim(),
      proxy: $('#fm-proxy').value.trim(),
    });
    const { error } = await sb.from('th_configs').upsert({ key: 'free_models', value, updated_at: new Date().toISOString() });
    toast(error ? error.message : '已保存并下发');
  };
}

/* ==================================================
   模块：系统设置
================================================== */
async function modSettings(main) {
  main.innerHTML = `
    <div class="page-title">系统设置</div>
    <div class="panel"><h3>会员等级配额</h3><div id="lv-list"></div></div>
    <div class="panel"><h3>分润比例</h3>
      <div class="form-row"><label>一级 / 二级 / 三级（%）</label>
      <div style="display:flex;gap:8px"><input id="r1" type="number" value="20"><input id="r2" type="number" value="5"><input id="r3" type="number" value="2"></div></div>
      <button class="btn btn-blue" id="r-save">保存比例</button>
    </div>
    <div class="panel"><h3>全局公告</h3>
      <div class="form-row"><textarea id="st-announce" placeholder="向所有用户展示的公告"></textarea></div>
      <button class="btn btn-blue" id="st-save">发布公告</button>
    </div>
    <div class="panel"><h3>维护模式</h3>
      <div class="form-row"><label>开启后客户端显示维护提示</label>
      <select id="st-maint"><option value="false">关闭</option><option value="true">开启</option></select></div>
      <button class="btn btn-red" id="mt-save">保存</button>
    </div>
    <div class="panel"><h3>Supabase 连接</h3>
      <div class="form-row"><label>URL</label><input id="sb-url" value="${esc(localStorage.getItem('adm:sb-url') || '')}"></div>
      <div class="form-row"><label>Anon Key</label><input id="sb-key" value="${esc(localStorage.getItem('adm:sb-key') || '')}"></div>
      <button class="btn" id="sb-save">保存并重载</button>
    </div>`;

  const { data: levels } = await sb.from('th_membership_levels').select('*').order('sort');
  $('#lv-list').innerHTML = `<table><thead><tr><th>ID</th><th>名称</th><th>容量（MB，-1 无限）</th><th>月费 ¥</th><th></th></tr></thead><tbody>` +
    (levels || []).map((l) => `
      <tr><td>${esc(l.id)}</td><td><input data-lv-name="${l.id}" value="${esc(l.name)}" style="width:80px"></td>
      <td><input data-lv-sto="${l.id}" type="number" value="${Math.round(l.storage_bytes / 1048576)}" style="width:110px"></td>
      <td><input data-lv-price="${l.id}" type="number" value="${l.price_month}" style="width:80px"></td>
      <td><button class="btn btn-sm btn-blue" data-lv-save="${l.id}">保存</button></td></tr>`).join('') + '</tbody></table>';

  $$('[data-lv-save]').forEach((b) => b.onclick = async () => {
    const id = b.dataset.lvSave;
    await sb.from('th_membership_levels').update({
      name: $(`[data-lv-name="${id}"]`).value,
      storage_bytes: +$(`[data-lv-sto="${id}"]`).value * 1048576,
      price_month: +$(`[data-lv-price="${id}"]`).value,
    }).eq('id', id);
    toast('已保存');
  });

  const { data: ratioCfg } = await sb.from('th_configs').select('value').eq('key', 'agent_rates').maybeSingle();
  if (ratioCfg && ratioCfg.value) {
    try { const r = JSON.parse(ratioCfg.value); $('#r1').value = r[0]; $('#r2').value = r[1]; $('#r3').value = r[2]; } catch (e) {}
  }
  $('#r-save').onclick = async () => {
    await sb.from('th_configs').upsert({ key: 'agent_rates', value: JSON.stringify([+$('#r1').value, +$('#r2').value, +$('#r3').value]), updated_at: new Date().toISOString() });
    toast('已保存');
  };

  const { data: ann } = await sb.from('th_configs').select('value').eq('key', 'announcement').maybeSingle();
  if (ann) $('#st-announce').value = ann.value || '';
  $('#st-save').onclick = async () => {
    await sb.from('th_configs').upsert({ key: 'announcement', value: $('#st-announce').value, updated_at: new Date().toISOString() });
    toast('公告已发布');
  };

  const { data: mt } = await sb.from('th_configs').select('value').eq('key', 'maintenance').maybeSingle();
  if (mt) $('#st-maint').value = mt.value === 'true' ? 'true' : 'false';
  $('#mt-save').onclick = async () => {
    await sb.from('th_configs').upsert({ key: 'maintenance', value: $('#st-maint').value, updated_at: new Date().toISOString() });
    toast('已保存');
  };

  $('#sb-save').onclick = () => {
    localStorage.setItem('adm:sb-url', $('#sb-url').value.trim());
    localStorage.setItem('adm:sb-key', $('#sb-key').value.trim());
    location.reload();
  };
}

const MODULES = {
  dashboard: modDashboard,
  users: modUsers,
  agents: modAgents,
  orders: modOrders,
  cards: modCards,
  updates: modUpdates,
  freemodels: modFreeModels,
  settings: modSettings,
};

boot();
