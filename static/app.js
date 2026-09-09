/* 牛客刷题记录 —— 前端逻辑 */

/* ===== 日期工具（一律浏览器本地时区；禁止 new Date('YYYY-MM-DD')，避免被当 UTC 偏移） ===== */
function parseDate(s) {
  var p = s.split('-').map(Number);
  return new Date(p[0], p[1] - 1, p[2]); // 本地零点
}

function pad2(n) { return (n < 10 ? '0' : '') + n; }

function formatDate(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function addDays(d, n) {
  var x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); // 本地零点
  x.setDate(x.getDate() + n);
  return x;
}

function todayMid() {
  var n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
}

function daysInMonth(y, m) {
  return new Date(y, m + 1, 0).getDate();
}

/* ===== 配色（GitHub 绿色系，按当天普通刷题数量分档） ===== */
var LEVELS = ['#ebedf0', '#9be9a8', '#40c463', '#30a14e', '#216e39'];

function colorFor(count) {
  if (count <= 0) return LEVELS[0];
  if (count <= 2) return LEVELS[1];
  if (count <= 5) return LEVELS[2];
  if (count <= 9) return LEVELS[3];
  return LEVELS[4];
}

/* ===== 状态 ===== */
var recordsMap = new Map(); // date -> record（跨所有年份，用于按年翻页）
var curYear = null;         // 当前展示的年份
var today = todayMid();
var todayStr = formatDate(today);
var submissionsMap = new Map();
var selectedPassedDate = todayStr;

function renderPassedList(ds) {
  selectedPassedDate = ds || todayStr;
  var list = document.getElementById('passed-list');
  var empty = document.getElementById('passed-empty');
  var dateEl = document.getElementById('passed-date');
  if (!list || !empty || !dateEl) return;
  dateEl.textContent = selectedPassedDate;
  list.textContent = '';
  var rows = submissionsMap.get(selectedPassedDate) || [];
  empty.hidden = rows.length > 0;
  rows.forEach(function (item) {
    var row = document.createElement('div');
    row.className = 'passed-item';
    var time = document.createElement('time');
    time.textContent = item.created_at ? item.created_at.slice(11, 19) : '--:--:--';
    var raw = String(item.problem_key || '');
    var split = raw.indexOf('|');
    var target = split >= 0 ? raw.slice(0, split) : raw;
    var title = split >= 0 ? raw.slice(split + 1) : raw;
    var link = document.createElement('a');
    link.href = /^https?:\/\//i.test(target) ? target : 'https://' + target;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = title || target;
    row.appendChild(time);
    row.appendChild(link);
    list.appendChild(row);
  });
}

function submissionName(item) {
  var raw = String(item && item.problem_key || '');
  var split = raw.indexOf('|');
  return (split >= 0 ? raw.slice(split + 1) : raw) || '未命名题目';
}

function renderDeleteSubmissionList() {
  var list = document.getElementById('delete-submission-list');
  var empty = document.getElementById('delete-submission-empty');
  if (!list || !empty) return;
  list.textContent = '';
  var rows = submissionsMap.get(todayStr) || [];
  empty.hidden = rows.length > 0;
  rows.forEach(function (item) {
    var row = document.createElement('div');
    row.className = 'delete-submission-item';
    var name = document.createElement('span');
    name.className = 'delete-submission-name';
    name.textContent = submissionName(item);
    name.title = String(item.problem_key || '');
    var button = document.createElement('button');
    button.type = 'button';
    button.textContent = '删除';
    button.addEventListener('click', function () { openConfirmDelete(item); });
    row.appendChild(name);
    row.appendChild(button);
    list.appendChild(row);
  });
}

/* ===== 顶栏：显示今天是几月几号 ===== */
document.getElementById('today-date').textContent =
  today.getFullYear() + '年' + (today.getMonth() + 1) + '月' + today.getDate() + '日';

/* ===== 年份翻页 ===== */
var MIN_YEAR = 2000; // 往回翻页的下限：没有数据也可翻到空白年份补记；有更早记录则以记录年份为准
var HEATMAP_DAILY_COL = '#2da44e'; // 每日一题足迹：已完成当天的绿色

var heatmapPages = [
  { gridId: 'heatmap', hintId: 'heatmap-hint', prevId: 'btn-prev', nextId: 'btn-next', yearId: 'heatmap-year', mode: 'count' },
  { gridId: 'heatmap-daily', hintId: 'heatmap-hint-d', prevId: 'btn-prev-d', nextId: 'btn-next-d', yearId: 'heatmap-year-d', mode: 'daily' }
];

function yearRange() {
  var maxY = today.getFullYear(); // 不允许翻到未来年份
  var minY = MIN_YEAR;
  recordsMap.forEach(function (r) {
    var y = parseInt(r.date.slice(0, 4), 10);
    if (y < minY) minY = y;
  });
  return { min: minY, max: maxY };
}

function setYearLabels() {
  var r = yearRange();
  heatmapPages.forEach(function (p) {
    document.getElementById(p.yearId).textContent = curYear + ' 年';
    document.getElementById(p.prevId).disabled = curYear <= r.min;
    document.getElementById(p.nextId).disabled = curYear >= r.max;
  });
}

function fmtDayHeading(ds) {
  var d = parseDate(ds);
  return ds + ' · 星期' + '日一二三四五六'.charAt(d.getDay());
}

function makeDayCell(extra) {
  var c = document.createElement('div');
  c.className = 'day' + (extra ? ' ' + extra : '');
  return c;
}

/* ===== 热力图通用渲染：按年分页，每年 1月..12月 从左到右；每月一块 7 列小日历（周一..周日） ===== */
function renderHeatmapGrid(p) {
  var grid = document.getElementById(p.gridId);
  grid.textContent = '';
  var hasDataOnPage = false;

  for (var m = 0; m < 12; m++) {
    var wrap = document.createElement('div');
    wrap.className = 'mblock-col';

    var name = document.createElement('div');
    name.className = 'mblock-name';
    name.textContent = (m + 1) + '月';
    wrap.appendChild(name);

    var b = document.createElement('div');
    b.className = 'mblock';

    var dim = daysInMonth(curYear, m);
    var offset = (new Date(curYear, m, 1).getDay() + 6) % 7; // 1号是周几：周一=0 … 周日=6
    for (var k = 0; k < offset; k++) { // 1号前当月尚无日期的空位
      b.appendChild(makeDayCell('blank'));
    }

    for (var day = 1; day <= dim; day++) {
      var ds = curYear + '-' + pad2(m + 1) + '-' + pad2(day);
      var d = parseDate(ds);

      if (d.getTime() > today.getTime()) { // 尚未到来的日期：灰显、不可点
        var fc = makeDayCell('future');
        fc.title = ds + '：尚未到来';
        b.appendChild(fc);
        continue;
      }

      var rec = recordsMap.get(ds);
      var color, title;
      if (p.mode === 'daily') {
        var done = !!(rec && rec.is_daily === 1);
        if (done) hasDataOnPage = true;
        color = done ? HEATMAP_DAILY_COL : LEVELS[0];
        title = ds + '：' + (done ? '已完成每日一题' : '未完成每日一题');
      } else {
        if (rec) hasDataOnPage = true;
        color = rec ? colorFor(rec.count) : LEVELS[0];
        title = rec ? (ds + '：' + rec.count + ' 题') : (ds + '：无记录');
      }

      var cell = makeDayCell(ds === todayStr ? 'today' : '');
      cell.style.background = color;
      cell.title = title;
      (function (key, md) {
        cell.addEventListener('click', function () {
          if (md === 'daily') openDailyModal(key);
          else { openCountModal(key); renderPassedList(key); }
        });
      })(ds, p.mode);
      b.appendChild(cell);
    }

    wrap.appendChild(b);
    grid.appendChild(wrap);
  }

  document.getElementById(p.hintId).hidden = hasDataOnPage;
}

function renderHeatmaps() {
  heatmapPages.forEach(function (p) { renderHeatmapGrid(p); });
  setYearLabels();
}

function stepYear(delta) {
  var r = yearRange();
  var ny = curYear + delta;
  if (ny >= r.min && ny <= r.max) { curYear = ny; renderHeatmaps(); }
}

heatmapPages.forEach(function (p) {
  document.getElementById(p.prevId).addEventListener('click', function () { stepYear(-1); });
  document.getElementById(p.nextId).addEventListener('click', function () { stepYear(1); });
});

function renderSummary(sum) {
  document.getElementById('stat-total').textContent = sum.total_count;
  document.getElementById('stat-best').textContent = sum.best_day_count;
  document.getElementById('stat-best-date').textContent = sum.best_day_date || '--';
  document.getElementById('stat-streak').textContent = sum.streak;
  document.getElementById('stat-problem-streak').textContent = sum.problem_streak;
}

/* ===== 今日快捷操作 ===== */
var todayCountEl = document.getElementById('today-count');
var btnDailyToggle = document.getElementById('btn-daily-toggle');
var btnCountPlus = document.getElementById('btn-count-plus');
var btnCountDelete = document.getElementById('btn-count-delete');

function updateTodayBar() {
  var rec = recordsMap.get(todayStr);
  var count = rec ? rec.count : 0;
  var daily = !!(rec && rec.is_daily === 1);
  todayCountEl.textContent = count;
  btnDailyToggle.classList.toggle('on', daily);
  btnDailyToggle.textContent = daily ? '每日一题：已完成' : '每日一题';
}

function saveToday(body) {
  fetch('/api/records', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then(function (resp) {
    return resp.json().catch(function () { return {}; }).then(function (data) {
      if (!resp.ok) {
        alert((data && data.error) || '保存失败（HTTP ' + resp.status + '）');
        return;
      }
      return refresh();
    });
  }).catch(function (e) { alert('保存失败：' + e.message); });
}

btnDailyToggle.addEventListener('click', function () {
  var rec = recordsMap.get(todayStr);
  saveToday({
    date: todayStr,
    count: rec ? rec.count : 0,
    is_daily: (rec && rec.is_daily === 1) ? 0 : 1
  });
});

btnCountPlus.addEventListener('click', function () {
  openSubmissionModal();
});

function refresh() {
  return Promise.all([
    fetch('/api/records', { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error('records HTTP ' + r.status); return r.json(); }),
    fetch('/api/summary', { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error('summary HTTP ' + r.status); return r.json(); })
  ]).then(function (arr) {
    var recs = arr[0].records;
    var sum = arr[1];
    recordsMap = new Map(recs.map(function (r) { return [r.date, r]; }));

    if (curYear === null) { // 首次进入：定位到最近有记录的年份，否则当年
      var latest = today.getFullYear();
      recordsMap.forEach(function (r) {
        var y = parseInt(r.date.slice(0, 4), 10);
        if (y > latest) latest = y;
      });
      curYear = latest;
    }

    renderSummary(sum);
    renderHeatmaps();
    updateTodayBar();
    renderPassedList(selectedPassedDate || todayStr);
    return loadSubmissions().then(function (data) {
      submissionsMap = new Map();
      (data.submissions || []).forEach(function (item) {
        if (!submissionsMap.has(item.date)) submissionsMap.set(item.date, []);
        submissionsMap.get(item.date).push(item);
      });
      renderPassedList(selectedPassedDate || todayStr);
      renderDeleteSubmissionList();
    }).catch(function (error) {
      console.error('[CodeAgenda] 读取已通过题目失败:', error);
      submissionsMap = new Map();
      renderPassedList(selectedPassedDate || todayStr);
    });
  });
}

function loadSubmissions() {
  return fetch('/api/submissions', { cache: 'no-store' }).then(function (r) {
    if (!r.ok) throw new Error('submissions HTTP ' + r.status);
    return r.json();
  }).then(function (data) {
    submissionsMap = new Map();
    (data.submissions || []).forEach(function (item) {
      if (!submissionsMap.has(item.date)) submissionsMap.set(item.date, []);
      submissionsMap.get(item.date).push(item);
    });
    return data;
  });
}

/* ===== 模态框 ===== */
var mask = document.getElementById('modal-mask');
var modalDateEl = document.getElementById('modal-date');
var countInput = document.getElementById('modal-count');
var btnSave = document.getElementById('btn-save');
var btnCancel = document.getElementById('btn-cancel');

var maskDaily = document.getElementById('modal-mask-daily');
var modalDateDailyEl = document.getElementById('modal-date-d');
var dailyCheck = document.getElementById('modal-daily');
var btnSaveD = document.getElementById('btn-save-d');
var btnCancelD = document.getElementById('btn-cancel-d');

var maskSubmission = document.getElementById('modal-mask-submission');
var submissionNameInput = document.getElementById('modal-submission-name');
var submissionUrlInput = document.getElementById('modal-submission-url');
var btnSaveSubmission = document.getElementById('btn-save-submission');
var btnCancelSubmission = document.getElementById('btn-cancel-submission');

var maskDelete = document.getElementById('modal-mask-delete');
var btnCancelDelete = document.getElementById('btn-cancel-delete');
var maskConfirmDelete = document.getElementById('modal-mask-confirm-delete');
var confirmDeleteText = document.getElementById('confirm-delete-text');
var btnConfirmDeleteNo = document.getElementById('btn-confirm-delete-no');
var btnConfirmDeleteYes = document.getElementById('btn-confirm-delete-yes');
var pendingDeleteSubmission = null;

var currentDate = null; // 两个弹窗共用；同时只会打开一个

function postRecord(body) {
  return fetch('/api/records', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then(function (resp) {
    return resp.json().catch(function () { return {}; }).then(function (data) {
      if (!resp.ok) {
        alert((data && data.error) || '保存失败（HTTP ' + resp.status + '）');
        return false;
      }
      return true;
    });
  }).catch(function (e) {
    alert('保存失败：' + e.message);
    return false;
  });
}

function openSubmissionModal() {
  if (!maskSubmission || !submissionNameInput || !submissionUrlInput) {
    alert('页面资源已更新，请刷新页面后重试');
    return;
  }
  submissionNameInput.value = '';
  submissionUrlInput.value = '';
  maskSubmission.classList.add('open');
  submissionNameInput.focus();
}

function closeSubmissionModal() { maskSubmission.classList.remove('open'); }

btnSaveSubmission.addEventListener('click', function () {
  var title = String(submissionNameInput.value || '').trim();
  var raw = String(submissionUrlInput.value || '').trim();
  if (!title) { alert('请输入题目名称'); submissionNameInput.focus(); return; }
  if (!raw) { alert('请输入本题链接'); submissionUrlInput.focus(); return; }
  var link = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'https://' + raw;
  try { new URL(link); } catch (e) { alert('请输入有效的题目链接'); submissionUrlInput.focus(); return; }
  btnSaveSubmission.disabled = true;
  fetch('/api/submissions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: todayStr, problem_url: link, problem_title: title })
  }).then(function (resp) {
    return resp.json().catch(function () { return {}; }).then(function (data) {
      if (!resp.ok) throw new Error((data && data.error) || 'HTTP ' + resp.status);
      if (data.duplicate) {
        alert(data.message || '今天已经通过了，重复提交无效');
        return;
      }
      closeSubmissionModal();
      return refresh();
    });
  }).catch(function (e) { alert('保存失败：' + e.message); })
    .then(function () { btnSaveSubmission.disabled = false; });
});

btnCancelSubmission.addEventListener('click', closeSubmissionModal);

function openDeleteModal() {
  loadSubmissions().then(function () {
    renderDeleteSubmissionList();
    maskDelete.classList.add('open');
  }).catch(function (e) { alert('读取今日题目失败：' + e.message); });
}

function closeDeleteModal() { maskDelete.classList.remove('open'); }

function openConfirmDelete(item) {
  pendingDeleteSubmission = item;
  confirmDeleteText.textContent = '确定删除“' + submissionName(item) + '”吗？删除后将无法恢复。';
  closeDeleteModal();
  maskConfirmDelete.classList.add('open');
}

function closeConfirmDelete() {
  maskConfirmDelete.classList.remove('open');
  pendingDeleteSubmission = null;
}

btnCountDelete.addEventListener('click', openDeleteModal);
btnCancelDelete.addEventListener('click', closeDeleteModal);
btnConfirmDeleteNo.addEventListener('click', function () {
  closeConfirmDelete();
  openDeleteModal();
});
btnConfirmDeleteYes.addEventListener('click', function () {
  if (!pendingDeleteSubmission || !pendingDeleteSubmission.id) return;
  btnConfirmDeleteYes.disabled = true;
  fetch('/api/submissions/' + encodeURIComponent(pendingDeleteSubmission.id), { method: 'DELETE' })
    .then(function (resp) {
      return resp.json().catch(function () { return {}; }).then(function (data) {
        if (!resp.ok) throw new Error((data && data.error) || 'HTTP ' + resp.status);
        closeConfirmDelete();
        return refresh();
      });
    }).then(function () {
      openDeleteModal();
    }).catch(function (e) { alert('删除失败：' + e.message); })
    .then(function () { btnConfirmDeleteYes.disabled = false; });
});

/* --- 填写数量弹窗：只改普通题数，保留当天每日一题状态 --- */
function openCountModal(ds) {
  currentDate = ds;
  modalDateEl.textContent = fmtDayHeading(ds);
  var rec = recordsMap.get(ds);
  countInput.value = (rec && rec.count > 0) ? rec.count : ''; // 无记录/0题留空，不预填 0
  mask.classList.add('open');
  countInput.focus();
}

function closeCountModal() {
  mask.classList.remove('open');
  currentDate = null;
}

btnSave.addEventListener('click', function () {
  if (!currentDate) return;
  var raw = String(countInput.value).trim();
  var count = raw === '' ? 0 : parseInt(raw, 10);
  if (isNaN(count) || count < 0) count = 0; // 空/非法输入按 0 处理
  var rec = recordsMap.get(currentDate);
  var is_daily = (rec && rec.is_daily === 1) ? 1 : 0;
  postRecord({ date: currentDate, count: count, is_daily: is_daily }).then(function (ok) {
    if (ok) { closeCountModal(); return refresh(); }
  });
});

btnCancel.addEventListener('click', closeCountModal);

/* --- 每日一题弹窗：只改每日一题状态，保留当天普通题数 --- */
function openDailyModal(ds) {
  currentDate = ds;
  modalDateDailyEl.textContent = fmtDayHeading(ds);
  var rec = recordsMap.get(ds);
  dailyCheck.checked = !!(rec && rec.is_daily === 1);
  maskDaily.classList.add('open');
}

function closeDailyModal() {
  maskDaily.classList.remove('open');
  currentDate = null;
}

btnSaveD.addEventListener('click', function () {
  if (!currentDate) return;
  var rec = recordsMap.get(currentDate);
  var count = (rec && rec.count > 0) ? rec.count : 0;
  var is_daily = dailyCheck.checked ? 1 : 0;
  postRecord({ date: currentDate, count: count, is_daily: is_daily }).then(function (ok) {
    if (ok) { closeDailyModal(); return refresh(); }
  });
});

btnCancelD.addEventListener('click', closeDailyModal);

/* ===== 导出 / 导入 ===== */
document.getElementById('btn-export').addEventListener('click', function () {
  fetch('/api/export')
    .then(function (resp) {
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      return resp.json();
    })
    .then(function (data) {
      var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'niuke-records-' + formatDate(new Date()) + '.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    })
    .catch(function (e) { alert('导出失败：' + e.message); });
});

var fileInput = document.getElementById('import-file');
document.getElementById('btn-import').addEventListener('click', function () {
  fileInput.click();
});

fileInput.addEventListener('change', function () {
  var f = fileInput.files[0];
  fileInput.value = '';
  if (!f) return;
  f.text()
    .then(function (text) { return JSON.parse(text); })
    .then(function (body) {
      return fetch('/api/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }).then(function (resp) {
        return resp.json().catch(function () { return {}; }).then(function (data) {
          if (!resp.ok) {
            alert((data && data.error) || '导入失败（HTTP ' + resp.status + '）');
            return;
          }
          alert('导入成功：' + data.imported + ' 条记录');
          return refresh();
        });
      });
    })
    .catch(function (e) { alert('导入失败：' + e.message); });
});

/* ===== 设置界面 ===== */
var settingsMask = document.getElementById('settings-mask');
var btnOpenSettings = document.getElementById('btn-settings');
var btnCloseSettings = document.getElementById('btn-close-settings');
var btnCancelSettings = document.getElementById('btn-cancel-settings');
var btnSaveSettings = document.getElementById('btn-save-settings');
var ncAccount = document.getElementById('nc-account');
var ncPassword = document.getElementById('nc-password');
var saveTimer = null;

function openSettings() {
  settingsMask.classList.add('open');
  // 预填已保存的账号与密码；网络失败则保持空白
  fetch('/api/settings')
    .then(function (r) { return r.json(); })
    .then(function (data) {
      var nc = (data && data.nowcoder) || {};
      ncAccount.value = nc.account || '';
      ncPassword.value = nc.password || '';
    })
    .catch(function () {
      ncAccount.value = '';
      ncPassword.value = '';
    });
  ncAccount.focus();
}

function closeSettings() {
  settingsMask.classList.remove('open');
  clearTimeout(saveTimer);
  btnSaveSettings.textContent = '保存';
}

btnOpenSettings.addEventListener('click', openSettings);
btnCloseSettings.addEventListener('click', closeSettings);
btnCancelSettings.addEventListener('click', closeSettings);

btnSaveSettings.addEventListener('click', function () {
  var body = { account: ncAccount.value.trim(), password: ncPassword.value };
  fetch('/api/settings/nowcoder', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then(function (resp) {
    return resp.json().catch(function () { return {}; }).then(function (data) {
      if (!resp.ok) {
        alert((data && data.error) || '保存失败（HTTP ' + resp.status + '）');
        return;
      }
      btnSaveSettings.textContent = '已保存';
      clearTimeout(saveTimer);
      saveTimer = setTimeout(function () { btnSaveSettings.textContent = '保存'; }, 1500);
    });
  }).catch(function (e) { alert('保存失败：' + e.message); });
});

/* ===== 设置左侧分栏切换（当前仅一栏，预留多栏） ===== */
var settingsNavItems = document.querySelectorAll('.settings-nav-item');
var settingsPanels = document.querySelectorAll('.settings-panel');

function switchSettingsPanel(target) {
  Array.prototype.forEach.call(settingsNavItems, function (it) {
    it.classList.toggle('is-active', it.getAttribute('data-target') === target);
  });
  Array.prototype.forEach.call(settingsPanels, function (p) {
    p.classList.toggle('is-active', p.id === target);
  });
}

Array.prototype.forEach.call(settingsNavItems, function (it) {
  it.addEventListener('click', function () {
    switchSettingsPanel(it.getAttribute('data-target'));
  });
});

/* ===== 通用：页面背景照片 ===== */
var bodyEl = document.body;
var currentBg = '';
var bgPreview = document.getElementById('bg-preview');
var btnChooseBg = document.getElementById('btn-choose-bg');
var btnRemoveBg = document.getElementById('btn-remove-bg');
var bgFile = document.getElementById('bg-file');
var bgStatus = document.getElementById('bg-status');
var bgTimer = null;

function showBgStatus(text, isError) {
  bgStatus.textContent = text;
  bgStatus.hidden = false;
  bgStatus.style.color = isError ? '#d70015' : '#1d1d1f';
  clearTimeout(bgTimer);
  bgTimer = setTimeout(function () { bgStatus.hidden = true; }, 2500);
}

// 无背景时清空内联样式，回到 CSS 默认的浅白外观
function applyBodyBackground(url) {
  if (!url) {
    bodyEl.style.background = '';
    return;
  }
  // 叠加一层半透明白色，保证前景文字仍清晰
  bodyEl.style.background =
    'linear-gradient(rgba(247, 249, 251, 0.72), rgba(247, 249, 251, 0.72)), ' +
    'url("' + url + '") center / cover fixed no-repeat';
}

function refreshBgPreview() {
  bgPreview.style.backgroundImage = currentBg ? 'url("' + currentBg + '")' : 'none';
  bgPreview.classList.toggle('has-bg', !!currentBg);
}

function loadAppearance() {
  return fetch('/api/settings')
    .then(function (r) { return r.json(); })
    .then(function (data) {
      var app = (data && data.appearance) || {};
      currentBg = app.background || '';
      applyBodyBackground(currentBg);
      refreshBgPreview();
    })
    .catch(function () { /* 网络失败保持默认外观 */ });
}

btnChooseBg.addEventListener('click', function () { bgFile.click(); });

bgFile.addEventListener('change', function () {
  var file = bgFile.files[0];
  bgFile.value = '';
  if (!file) return;
  if (!/^image\//.test(file.type)) { showBgStatus('请选择图片文件', true); return; }
  if (file.size > 20 * 1024 * 1024) { showBgStatus('图片不能超过 20MB', true); return; }
  showBgStatus('正在上传…', false);
  var fd = new FormData();
  fd.append('file', file);
  fetch('/api/background', { method: 'POST', body: fd })
    .then(function (resp) {
      return resp.json().catch(function () { return {}; }).then(function (data) {
        if (!resp.ok) {
          showBgStatus((data && data.error) || '上传失败（HTTP ' + resp.status + '）', true);
          return;
        }
        currentBg = data.background;
        applyBodyBackground(currentBg); // 选完立即生效
        refreshBgPreview();
        showBgStatus('背景已更换', false);
      });
    })
    .catch(function (e) { showBgStatus('上传失败：' + e.message, true); });
});

btnRemoveBg.addEventListener('click', function () {
  fetch('/api/background', { method: 'DELETE' })
    .then(function (resp) {
      return resp.json().catch(function () { return {}; }).then(function (data) {
        if (!resp.ok) {
          showBgStatus((data && data.error) || '操作失败（HTTP ' + resp.status + '）', true);
          return;
        }
        currentBg = '';
        applyBodyBackground('');
        refreshBgPreview();
        showBgStatus('已恢复默认白色背景', false);
      });
    })
    .catch(function (e) { showBgStatus('操作失败：' + e.message, true); });
});

/* ===== 启动 ===== */
loadAppearance();
refresh().catch(function () { /* 网络失败时静默，避免未处理拒绝 */ });
// Tampermonkey 在牛客页面写入数据库后，主页面通过轻量轮询自动显示最新题目。
setInterval(function () {
  refresh().catch(function () { /* 后端暂时不可用时保留当前界面 */ });
}, 5000);
