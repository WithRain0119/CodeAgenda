// ==UserScript==
// @name         CodeAgenda - 牛客刷题同步
// @namespace    codeagenda.local
// @version      1.6.0
// @description  自动同步牛客每日一题和 Accepted 提交到本地 CodeAgenda
// @match        https://www.nowcoder.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  var pageWindow = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

  var API_BASE = 'http://127.0.0.1:5000';
  var DAILY_MARKER_KEY = 'codeagenda_daily_synced_v2';
  var AC_COOLDOWN_MS = 5000;
  var lastAcSyncAt = 0;
  var acSyncInFlight = false;
  var dailySyncInFlight = false;
  var trackerDailyKey = '';
  var acReady = false;
  var submissionArmed = false;
  var lastSubmitAt = '';
  var lastSuccessSignal = '';
  var lastSuccessAt = '';
  var successWatchTimer = null;
  var watchAttempts = 0;
  var lastWatchSignal = '';
  var lastRequestInfo = '';
  var lastRequestResponse = '';
  var lastRequestError = '';
  var lastGateInfo = '';
  var lastProbeSignal = '';
  var dailyDebug = { trackerFound: false, trackerTitle: '', trackerUrl: '', dbProblem: '', currentUrl: '', match: '未检查', result: '', error: '' };
  // var DEBUG = true; // Original debug logging switch; restore when troubleshooting.
  var DEBUG = false;

  function log() {
    var args = Array.prototype.slice.call(arguments);
    args.unshift('[CodeAgenda]');
    console.log.apply(console, args);
  }

  function debug() {
    if (!DEBUG) return;
    var args = Array.prototype.slice.call(arguments);
    args.unshift('[CodeAgenda debug]');
    console.debug.apply(console, args);
  }

  // ---- 判定链路追踪 ----------------------------------------------------------
  // 目的：下次再出现"没通过却被记成通过"时，日志里要能还原出是哪一次点击、哪一条接口响应、
  // 在点击之后多少毫秒把它判成了通过。所以只记录判定链路（点击归属、判题提示变化、
  // 探针命中与否决、记账请求与结果），不记录每 150ms 的轮询和每次 DOM 扫描，免得刷爆日志窗口。
  // 日志经 /api/client-log 落到后端 stdout，也就是托盘日志窗口和导出的 log/runtime.log。
  var SCRIPT_VERSION = '1.6.0';
  var TRACE_PATH = '/api/client-log';
  var TRACE_FLUSH_MS = 1500;   // 攒够时间就发，避免一次判题拆成几十个请求
  var TRACE_BATCH_MAX = 20;
  var TRACE_RING_MAX = 400;    // 内存里留最近若干条，供 syncHelper.dumpLog() 取用
  var traceBootAt = Date.now();
  var traceSeq = 0;
  var tracePending = [];
  var traceTimer = null;
  var traceRing = [];

  function clip(value, limit) {
    var text = String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim();
    limit = limit || 120;
    return text.length > limit ? text.slice(0, limit) + '…（共' + text.length + '字）' : text;
  }

  // 元素只记标签和 class：日志里认的是"提示挂在哪个容器上"，不是整段 innerHTML。
  function nodeTag(element) {
    if (!element || !element.tagName) return '(无元素)';
    var cls = element.className && typeof element.className === 'string'
      ? '.' + clip(element.className, 60).replace(/ /g, '.') : '';
    return '<' + element.tagName.toLowerCase() + cls + '>';
  }

  function nodeInfo(element) {
    return nodeTag(element) + '“' + clip(element && (element.innerText || element.textContent), 40) + '”';
  }

  // 距离"点击提交"的毫秒数。误报多半是时序问题（响应先到、判错后渲染），所以每条日志都要带它。
  function sinceClick() {
    return attemptStartedAt ? (Date.now() - attemptStartedAt) + 'ms' : '本次页面还没有提交动作';
  }

  // 带自增序号与开机偏移：多个异步来源（DOM 扫描 / 接口探针 / 记账请求）也能排出真实先后。
  // 整体包在 try 里：日志出问题绝不能连累判题记账——记账失败可以补，误判通过却删不回来。
  function trace(event, fields) {
    try {
      var parts = [];
      fields = fields || {};
      for (var name in fields) {
        if (fields[name] === undefined || fields[name] === null || fields[name] === '') continue;
        parts.push(name + '=' + fields[name]);
      }
      var line = '#' + (++traceSeq) + ' +' + (Date.now() - traceBootAt) + 'ms ' + event +
        (parts.length ? ' ' + parts.join(' ') : '');
      traceRing.push(line);
      if (traceRing.length > TRACE_RING_MAX) traceRing.splice(0, traceRing.length - TRACE_RING_MAX);
      tracePending.push(line);
      if (tracePending.length >= TRACE_BATCH_MAX) flushTrace();
      else if (!traceTimer) traceTimer = setTimeout(flushTrace, TRACE_FLUSH_MS);
    } catch (e) {
      try { console.warn('[CodeAgenda] 写日志失败，已忽略:', e); } catch (ignored) {}
    }
  }

  // 上报失败（后端没起、或还停在没有这个接口的旧版本）必须能看出来，否则"日志里什么都没有"
  // 会被误当成"脚本没跑"。失败就退回队列等下一次补发，控制台也提示前几次。
  var TRACE_RETRY_MS = 10000;
  var traceSendErrors = 0;

  function noteTraceSendError(reason) {
    traceSendErrors += 1;
    if (traceSendErrors > 3) return;
    try {
      console.warn('[CodeAgenda] 判定链路日志没能写进日志窗口（' + reason + '，第 ' + traceSendErrors + ' 次）。'
        + '常见原因是后端还没重启到新版；日志已暂存在页面内存里，可用 window.syncHelper.dumpLog() 取出。');
    } catch (e) { /* 控制台都没有就算了 */ }
  }

  function restorePending(events) {
    var lines = [];
    for (var i = 0; i < events.length; i += 1) {
      if (events[i] && events[i].line) lines.push(events[i].line);
    }
    if (!lines.length) return;
    // 队列有上限：后端长时间连不上时只留最近这些，免得页面内存被日志吃光。
    tracePending = lines.concat(tracePending).slice(-TRACE_RING_MAX);
    if (!traceTimer) traceTimer = setTimeout(flushTrace, TRACE_RETRY_MS);
  }

  function flushTrace() {
    if (traceTimer) { clearTimeout(traceTimer); traceTimer = null; }
    if (!tracePending.length) return;
    var events = tracePending.splice(0, tracePending.length).map(function (line) { return { line: line }; });
    try {
      // 不走 request()：这条请求不该顶掉调试面板里的"最近一次请求"，也不参与判题判定。
      GM_xmlhttpRequest({
        method: 'POST',
        url: API_BASE + TRACE_PATH,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ events: events }),
        timeout: 8000,
        onload: function (response) {
          if (response.status < 200 || response.status >= 300) {
            noteTraceSendError('后端返回 HTTP ' + response.status);
            restorePending(events);
          }
        },
        onerror: function () { noteTraceSendError('连不上后端'); restorePending(events); },
        ontimeout: function () { noteTraceSendError('上报超时'); restorePending(events); }
      });
    } catch (e) { /* 日志送不出去不能影响正常同步 */ }
  }

  function today() {
    var d = new Date();
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function request(method, path, body) {
    lastRequestInfo = method + ' ' + API_BASE + path;
    lastRequestError = '';
    log('发送请求:', lastRequestInfo, body || '');
    return new Promise(function (resolve, reject) {
      GM_xmlhttpRequest({
        method: method,
        url: API_BASE + path,
        headers: { 'Content-Type': 'application/json' },
        data: body === undefined ? undefined : JSON.stringify(body),
        timeout: 10000,
        onload: function (response) {
          var data = {};
          try { data = response.responseText ? JSON.parse(response.responseText) : {}; } catch (e) {}
          lastRequestResponse = response.status + ' ' + JSON.stringify(data).slice(0, 300);
          log('收到响应:', lastRequestResponse);
          if (response.status >= 200 && response.status < 300) return resolve(data);
          var error = new Error('HTTP ' + response.status + (data.error ? ': ' + data.error : ''));
          lastRequestError = error.message;
          reject(error);
        },
        onerror: function () { lastRequestError = '无法连接本地 CodeAgenda'; reject(new Error(lastRequestError)); },
        ontimeout: function () { lastRequestError = '请求超时'; reject(new Error(lastRequestError)); }
      });
    });
  }

  // 所有写入都先读取当天记录，再合并字段，避免覆盖用户手动填写的数据。
  function updateTodayRecord(newCount, newDaily) {
    var ds = today();
    return request('GET', '/api/records').then(function (data) {
      var rows = Array.isArray(data.records) ? data.records : [];
      var current = rows.find(function (r) { return r && r.date === ds; }) || {};
      var count;
      if (newCount === 'increment') count = (Number(current.count) || 0) + 1;
      else count = newCount === null || newCount === undefined ? Number(current.count) || 0 : Number(newCount);
      var daily = newDaily === null || newDaily === undefined ? (Number(current.is_daily) ? 1 : 0) : (newDaily ? 1 : 0);
      if (!Number.isInteger(count) || count < 0) throw new Error('count 必须是非负整数');
      return request('POST', '/api/records', { date: ds, count: count, is_daily: daily });
    }).then(function (result) {
      log('已同步', ds, result.record || result);
      return result;
    }).catch(function (error) {
      log('同步失败:', error.message);
      throw error;
    });
  }

  function textOf(element) {
    return ((element.innerText || element.textContent || '') + ' ' +
      (element.getAttribute && (element.getAttribute('aria-label') || element.getAttribute('title') || '') || '')).trim();
  }

  function isVisible(element) {
    if (!element || !element.getBoundingClientRect) return false;
    var style = window.getComputedStyle(element);
    var rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' &&
      style.opacity !== '0' && rect.width > 0 && rect.height > 0;
  }

  function isIgnoredNode(element) {
    return !!(element && element.closest && element.closest('#codeagenda-debug-panel'));
  }

  function isDailyComplete() {
    var nodes = document.querySelectorAll('body *');
    for (var i = 0; i < nodes.length; i += 1) {
      var text = textOf(nodes[i]);
      if (isIgnoredNode(nodes[i]) || !isVisible(nodes[i]) || text.length > 300) continue;
      var daily = /(每日一题|每日题|daily\s*(challenge|problem|question))/i.test(text);
      var positive = /(已完成|完成啦|打卡成功|已打卡|done|completed|finished)/i.test(text);
      var negative = /(未完成|待完成|去完成|开始答题|未打卡|not\s+done|incomplete|unfinished)/i.test(text);
      if (daily && positive && !negative) {
        debug('每日一题命中元素:', nodes[i], '文本:', text);
        return true;
      }
      if (daily && (positive || negative)) debug('每日一题候选:', { text: text, positive: positive, negative: negative });
    }
    debug('未找到明确的每日一题完成状态');
    return false;
  }

  /* DEBUG HELPERS DISABLED - uncomment this block when troubleshooting.
  function debugDaily() {
    DEBUG = true;
    var result = isDailyComplete();
    console.log('[CodeAgenda debug] 每日一题最终判断:', result);
    return result;
  }

  function debugState() {
    var state = {
      url: location.href,
      today: today(),
      problemKey: problemKey(),
      acReady: acReady,
      submissionArmed: submissionArmed,
      lastSubmitAt: lastSubmitAt,
      currentAcSignal: acSignal(),
      lastSuccessSignal: lastSuccessSignal,
      lastSuccessAt: lastSuccessAt,
      watchAttempts: watchAttempts,
      lastWatchSignal: lastWatchSignal,
      lastRequestInfo: lastRequestInfo,
      lastRequestResponse: lastRequestResponse,
      lastRequestError: lastRequestError,
      lastGateInfo: lastGateInfo,
      dailyDebug: dailyDebug,
      lastProbeSignal: lastProbeSignal,
      traceTail: traceRing.slice(-10)
    };
    console.table(state);
    log('调试状态:', state);
    return state;
  }

  function debugDatabase() {
    var ds = today();
    return request('GET', '/api/records').then(function (records) {
      return Promise.all([
        request('GET', '/api/submissions?date=' + encodeURIComponent(ds)),
        request('GET', '/api/daily-problems?date=' + encodeURIComponent(ds))
      ]).then(function (parts) {
        var submissions = parts[0];
        var daily = parts[1];
        var row = (records.records || []).find(function (r) { return r.date === ds; }) || null;
        var dailyProblem = daily.problems && daily.problems[0] ? daily.problems[0] : null;
        var result = { date: ds, record: row, submissions: submissions.submissions || [], dailyProblem: dailyProblem, currentProblemUrl: currentProblemUrl(), currentProblemKey: problemKey() };
        console.log('[CodeAgenda debug] 本地数据库诊断:', result);
        console.table(result.submissions);
        return result;
      });
    }).catch(function (error) {
      console.error('[CodeAgenda debug] 本地数据库请求失败:', error);
      throw error;
    });
  }
  */ // END DEBUG HELPERS

  /* DEBUG PANEL DISABLED - uncomment this block when troubleshooting.
  function installDebugPanel() {
    if (!document.body || document.getElementById('codeagenda-debug-panel')) return;
    var panel = document.createElement('div');
    panel.id = 'codeagenda-debug-panel';
    panel.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;width:300px;padding:10px;background:#fff;color:#1f2328;border:1px solid #d0d7de;border-radius:6px;box-shadow:0 3px 12px rgba(31,35,40,.2);font:12px/1.5 Arial,sans-serif;';
    panel.innerHTML = '<b>CodeAgenda 测试面板</b><div id="codeagenda-debug-text" style="margin:6px 0;word-break:break-all"></div><button id="codeagenda-check" type="button">检查当前状态</button> <button id="codeagenda-db" type="button">检查数据库</button>';
    document.body.appendChild(panel);
    var text = document.getElementById('codeagenda-debug-text');
    function showState() {
      var signal = acSignal();
      text.textContent = '脚本：已加载 | 题目：' + problemKey() +
        ' | 最近提交：' + (lastSubmitAt || '无') +
        ' | 当前成功提示：' + (signal || '无') +
        ' | 最近成功：' + (lastSuccessSignal || '无') +
        ' | 轮询：' + watchAttempts + '次' +
        ' | 网络探针：' + (lastProbeSignal || '无') +
        ' | 每日匹配：' + dailyDebug.match +
        ' | 每日结果：' + (dailyDebug.result || dailyDebug.error || '未处理') +
        ' | 请求：' + (lastRequestResponse || lastRequestError || '未发送');
    }
    document.getElementById('codeagenda-check').addEventListener('click', function () { showState(); debugDaily(); });
    document.getElementById('codeagenda-db').addEventListener('click', function () {
      text.textContent = '正在读取本地数据库...';
      debugDatabase().then(function (r) {
        var found = (r.submissions || []).some(function (x) { return x.problem_key === r.currentProblemKey; });
        text.textContent = '数据库连接成功 | 今日汇总：' + (r.record ? r.record.count + ' 题' : '无记录') + ' | 本题：' + (found ? '已有提交记录' : '无提交记录') + ' | 每日题：' + (r.dailyProblem ? r.dailyProblem.title : '未保存') + ' | 当前题是否每日题：' + (r.dailyProblem && canonicalUrl(r.dailyProblem.url) === r.currentProblemUrl ? '是' : '否');
      }).catch(function (e) { text.textContent = '数据库连接失败：' + e.message; });
    });
    showState();
    setInterval(showState, 500);
  }
  */ // END DEBUG PANEL

  // 判题通过的说法。只保留“判题结果”本身：
  // “提交成功 / 运行成功 / 编译成功 / 用例通过 / 全部通过”只说明提交或自测这个动作成功了，
  // 并不代表本题被判通过——把它们当成通过，就会出现“提交一次、不管过没过都被记成通过”。
  var successRe = /(答案正确|恭喜你通过本题|通过本题|Accepted)/i;
  // 判题失败的说法：本次提交出现它，这次提交就作废，之后页面上再冒出什么“通过”字样也不计入。
  // 英文判决一律要求带空格，避免误伤 timeLimit / wrongAnswer 这类字段名。
  var failRe = /(答案错误|部分正确|编译错误|运行错误|运行超时|内存超限|格式错误|段错误|浮点错误|返回非零|异常退出|多种错误|内部错误|Wrong\s+Answer|Compile\s+Error|Runtime\s+Error|Time\s+Limit\s+Exceeded|Memory\s+Limit\s+Exceeded)/i;
  // 还在判题中的说法：没出结果前不下结论。
  var pendingRe = /(等待评测|正在评测|评测中|判题中|Pending|Judging)/i;

  // 只看元素自身的文本节点。祖先容器的文本会随子节点变化（比如在代码编辑器里敲字），
  // 拿它当依据会把“页面上早就挂着的历史通过记录”当成刚出现的提示。
  function ownText(element) {
    var text = '';
    for (var i = 0; i < element.childNodes.length; i += 1) {
      if (element.childNodes[i].nodeType === 3) text += element.childNodes[i].nodeValue;
    }
    return text.trim();
  }

  // 一趟走完页面，把承载判题提示的元素按“通过 / 失败 / 判题中”分好类。
  function scanSignals() {
    var nodes = document.querySelectorAll('body *');
    var found = { pass: [], fail: [], pending: [] };
    for (var i = 0; i < nodes.length; i += 1) {
      if (isIgnoredNode(nodes[i]) || !isVisible(nodes[i])) continue;
      var text = ownText(nodes[i]);
      if (!text || /(通过率|提交次数|历史通过|通过人数)/i.test(text)) continue;
      // 失败优先：同一段文本既像通过又像失败时按失败处理，宁可漏记也不记错。
      var kind = failRe.test(text) ? 'fail' : (pendingRe.test(text) ? 'pending' : (successRe.test(text) ? 'pass' : ''));
      if (!kind) continue;
      var match = text.match(kind === 'pass' ? successRe : (kind === 'fail' ? failRe : pendingRe));
      found[kind].push({ node: nodes[i], text: text, signal: normalizeSignal(match[0]) });
    }
    return found;
  }

  // 一次“等待判题结果”的过程：点提交时先把页面上已有的提示记成基线，
  // 只有基线之后新出现的提示才算这次提交的结果。题目以前通过过时，牛客页面
  // （我的提交 / 提交记录）里一直挂着“答案正确”，旧实现会把它当成刚刚通过。
  var attemptBaseline = null;
  var attemptFailed = false;
  var attemptStartedAt = 0;
  var attemptUrl = '';
  var lastSignalNote = '';

  function baselined(item) {
    return !!attemptBaseline && attemptBaseline.get(item.node) === item.text;
  }

  function beginAttempt(source) {
    // 先记下重置前的状态：这次点击之前武装/判错是不是还挂着，决定误报发生时的现场怎么解释。
    var wasArmed = submissionArmed;
    var wasFailed = attemptFailed;
    attemptBaseline = new Map();
    attemptFailed = false;
    lastSignalNote = '';
    attemptStartedAt = Date.now();
    attemptUrl = location.href;
    var current = scanSignals();
    var items = current.pass.concat(current.fail, current.pending);
    for (var i = 0; i < items.length; i += 1) attemptBaseline.set(items[i].node, items[i].text);
    var known = [];
    var collect = function (kind, list) {
      for (var j = 0; j < list.length; j += 1) {
        known.push(kind + ':' + nodeTag(list[j].node) + '“' + clip(list[j].text, 40) + '”');
      }
    };
    collect('通过', current.pass);
    collect('失败', current.fail);
    collect('判题中', current.pending);
    submissionArmed = true;
    lastSubmitAt = new Date().toLocaleTimeString();
    // 基线里已经挂着"通过"是典型的误报来源（题目以前通过过），单独标出来，别混在一长串基线里。
    // "开始前是否已武装"同样关键：上一次提交如果既没判错也没记账，武装状态会一直挂着，
    // 之后页面上任何通过字样都会算到这道题上。
    trace('开始等待判题', {
      触发: source,
      题目: problemKey(),
      基线里的提示: known.length ? known.join(' | ') : '（页面上没有任何判题提示）',
      基线里已有通过提示: current.pass.length ? '是' : '否',
      开始前是否已武装: wasArmed ? '是（上次提交没结账，武装状态一直挂着）' : '否',
      开始前是否已判错: wasFailed ? '是' : '否'
    });
    watchForSuccess();
  }

  // 页面上判题提示的变化只记一次，否则每 150ms 的轮询会把同一行刷几十遍。
  function noteSignal(kind, item) {
    var key = kind + '|' + item.text;
    if (key === lastSignalNote) return;
    lastSignalNote = key;
    trace('判题提示出现', { 类型: kind, 提示: clip(item.text, 80), 元素: nodeTag(item.node), 距点击: sinceClick() });
  }

  // 本次提交的通过提示：基线里就有的、还在判题的、已经判失败的一律不算。
  function acSignal() {
    if (!attemptBaseline) return '';
    var current = scanSignals();
    var i;
    for (i = 0; i < current.fail.length; i += 1) {
      if (!baselined(current.fail[i]) && !attemptFailed) {
        attemptFailed = true;
        trace('本次提交判为失败', {
          提示: clip(current.fail[i].text, 80),
          元素: nodeTag(current.fail[i].node),
          距点击: sinceClick()
        });
        debug('本次提交已判失败:', current.fail[i].signal);
      }
    }
    if (attemptFailed) return '';
    for (i = 0; i < current.pending.length; i += 1) {
      if (!baselined(current.pending[i])) {
        noteSignal('判题中', current.pending[i]);
        debug('本次提交还在判题中:', current.pending[i].signal);
        return '';
      }
    }
    for (i = 0; i < current.pass.length; i += 1) {
      if (!baselined(current.pass[i])) {
        noteSignal('通过', current.pass[i]);
        return current.pass[i].signal;
      }
    }
    return '';
  }

  function normalizeSignal(signal) {
    return signal.replace(/\s+/g, ' ').slice(0, 160);
  }

  function problemKey() {
    // URL 在牛客题目页通常包含稳定的题目 ID；标题用于兼容 SPA 不改变 pathname 的情况。
    var path = location.pathname.replace(/\/+$/, '') || '/';
    var heading = document.querySelector('h1, [data-testid*="title"], [class*="title"], meta[property="og:title"]');
    var title = heading ? (heading.content || textOf(heading)) : (document.title || '');
    title = normalizeSignal(title);
    return location.host + path + (title ? '|' + title : '');
  }

  function recordSubmission(problem) {
    return request('POST', '/api/submissions', { date: today(), problem_key: problem });
  }

  function canonicalUrl(value) {
    try {
      var u = new URL(value, location.origin);
      return u.origin + u.pathname.replace(/\/+$/, '');
    } catch (e) { return String(value || '').split(/[?#]/)[0].replace(/\/+$/, ''); }
  }

  function currentProblemUrl() {
    return canonicalUrl(location.href);
  }

  function syncTrackerDailyProblem() {
    if (location.pathname !== '/problem/tracker') return;
    var link = document.querySelector('#daily-problem-container a.problem-title-link[href]');
    if (!link) { dailyDebug.trackerFound = false; debug('Tracker 尚未找到每日一题链接'); return; }
    var title = textOf(link);
    var url = canonicalUrl(link.href);
    dailyDebug.trackerFound = true;
    dailyDebug.trackerTitle = title;
    dailyDebug.trackerUrl = url;
    var key = today() + '|' + title + '|' + url;
    if (!title || !url || key === trackerDailyKey) return;
    trackerDailyKey = key;
    log('发现 Tracker 今日每日一题:', title, url);
    trace('发现今日每日一题', { 题名: title, 链接: url });
    request('POST', '/api/daily-problems', { date: today(), title: title, url: url }).then(function (data) {
      dailyDebug.result = 'Tracker 保存成功';
      debug('Tracker 每日一题保存响应:', data);
    }).catch(function (error) {
      trackerDailyKey = '';
      dailyDebug.error = error.message;
      trace('保存每日一题失败', { 题名: title, 错误: clip(error.message, 120) });
      log('保存每日一题失败:', error.message);
    });
  }

  function markDailyIfMatched() {
    // Do not trust the old browser marker here. The local daily_problems table
    // and the current problem URL are authoritative; records is derived server-side.
    return request('GET', '/api/daily-problems?date=' + encodeURIComponent(today())).then(function (data) {
      var p = data && data.problems && data.problems[0];
      dailyDebug.dbProblem = p ? (p.title + ' | ' + canonicalUrl(p.url)) : '(无记录)';
      dailyDebug.currentUrl = currentProblemUrl();
      if (!p || canonicalUrl(p.url) !== currentProblemUrl()) {
        dailyDebug.match = '不匹配';
        dailyDebug.result = '';
        trace('通过题不是今日每日一题', {
          当前题目地址: currentProblemUrl(),
          今日每日一题: p ? canonicalUrl(p.url) : '(未记录)'
        });
        log('当前通过题不是今日每日一题:', currentProblemUrl(), p ? canonicalUrl(p.url) : '(未记录)');
        return false;
      }
      dailyDebug.match = '匹配';
      trace('通过题就是今日每日一题', { 题名: p.title });
      // /api/submissions recalculates today's records row from details.db.
      // Do not write records.is_daily directly from the browser anymore.
      GM_setValue(DAILY_MARKER_KEY, today());
      dailyDebug.result = '已提交每日一题，records 将自动同步';
      log('当前通过题与今日每日一题匹配:', p.title);
      return Promise.resolve(true);
    }).catch(function (error) {
      dailyDebug.error = error.message;
      throw error;
    });
  }

  function syncDaily() {
    if (dailySyncInFlight || GM_getValue(DAILY_MARKER_KEY, '') === today() || !isDailyComplete()) return;
    dailySyncInFlight = true;
    log('检测到今日每日一题已完成');
    // The aggregate is derived from the accepted submission in details.db.
    // Keep this detector for diagnostics, but do not fabricate a record row.
    GM_setValue(DAILY_MARKER_KEY, today());
    dailySyncInFlight = false;
  }

  // source 只进日志：用来区分这次候选是页面扫描出来的，还是接口探针报上来的。
  function syncAccepted(signal, source) {
    var now = Date.now();
    lastWatchSignal = signal || '';
    lastGateInfo = 'ready=' + acReady + ', armed=' + submissionArmed + ', signal=' + (!!signal) + ', inFlight=' + acSyncInFlight + ', cooldown=' + (now - lastAcSyncAt < AC_COOLDOWN_MS) + ', failed=' + attemptFailed;
    debug('AC 检查:', lastGateInfo, signal || '(无成功提示)');
    if (!signal) return;
    // 被拦下的候选也要留痕：误报往往就是"本该被拦、却没写清为什么"的那一条。
    var blocked = '';
    if (!acReady) blocked = '脚本还没就绪';
    else if (!submissionArmed) blocked = '页面上没有点击提交';
    else if (attemptFailed) blocked = '本次提交已经判为失败';
    else if (acSyncInFlight) blocked = '上一次上报还没有返回';
    else if (now - lastAcSyncAt < AC_COOLDOWN_MS) blocked = '距上次上报不足 ' + AC_COOLDOWN_MS + 'ms';
    if (blocked) {
      trace('通过候选被拦下', {
        来源: source,
        信号: clip(signal, 80),
        原因: blocked,
        距点击: sinceClick(),
        门: lastGateInfo
      });
      return;
    }
    var key = normalizeSignal(signal);
    // 这里原本还有一层"本次页面加载内已经处理过这个结果"的内存去重（seenAcSignals）。
    // 它和数据库无关，于是会出现：界面里删掉一条错记后，同一道题当天再通过一次会被它
    // 悄悄挡掉、不上报（2026-09-19 那次"通过了但界面不显示"就是它）。
    // 服务端的 submissions 表有 UNIQUE(date, problem_key)，重复提交会返回 duplicate:true，
    // 幂等本来就由数据库保证，客户端不需要再记一份会过期的状态——去重交给服务端。
    // 一次提交最多产生一条记录这件事，由下面的 armed/inFlight/cooldown 三个门负责。
    acSyncInFlight = true;
    if (successWatchTimer) { clearInterval(successWatchTimer); successWatchTimer = null; }
    lastAcSyncAt = now;
    lastSuccessSignal = key;
    lastSuccessAt = new Date().toLocaleTimeString();
    log('检测到代码提交成功:', key);
    trace('判定通过并记账', {
      来源: source,
      信号: clip(key, 80),
      题目: problemKey(),
      距点击: sinceClick(),
      门: lastGateInfo
    });
    recordSubmission(problemKey()).then(function (result) {
      if (result.duplicate) log('该题今天已经计数，跳过重复提交');
      trace('记账完成', {
        题目: problemKey(),
        结果: result.duplicate ? '今天已记过，未新增' : '新增一条通过记录',
        当天计数: result.record ? result.record.count : '(无)',
        // 开始等待判题时在别的地址上，却把这笔记到了当前题目上——记错题的典型信号。
        判题开始时的地址: attemptUrl && attemptUrl !== location.href ? clip(attemptUrl, 160) : ''
      });
      submissionArmed = false;
      return markDailyIfMatched().catch(function (error) { log('每日一题匹配失败:', error.message); return false; }).then(function () { return result; });
    }).catch(function (error) {
      // 请求失败时不留下任何"已处理"标记，后续扫描会拿同一个结果重试（见函数开头的门）。
      trace('记账请求失败', { 题目: problemKey(), 错误: clip(error.message, 120) });
      log('AC 同步失败:', error.message);
    }).then(function () { acSyncInFlight = false; });
  }

  // 判题等待期间页面地址变了（SPA 路由、点了别的题目），这次结果就可能被记到别的题上。
  // 地址变化本身很安静，只留这一条痕迹。
  var lastSeenUrl = '';
  function noteUrlChange() {
    var url = location.href;
    if (url === lastSeenUrl) return;
    var previous = lastSeenUrl;
    lastSeenUrl = url;
    if (previous) trace('页面地址变化', { 从: clip(previous, 160), 到: clip(url, 160), 距点击: sinceClick() });
  }

  function scan() {
    noteUrlChange();
    syncTrackerDailyProblem();
    syncAccepted(acSignal(), '页面扫描');
  }

  function watchForSuccess() {
    if (successWatchTimer) clearInterval(successWatchTimer);
    var started = Date.now();
    watchAttempts = 0;
    successWatchTimer = setInterval(function () {
      watchAttempts += 1;
      if (Date.now() - started > 15000 || !submissionArmed) {
        // 超时后没判错也不解除武装，之后页面上任何"通过"字样都还会算到这道题上——留个记号。
        if (submissionArmed) {
          trace('等待判题结果超时', {
            轮询次数: watchAttempts,
            备注: '脚本仍在等待提交结果，本次提交之后再出现的通过提示都会算到这道题上'
          });
        }
        clearInterval(successWatchTimer);
        successWatchTimer = null;
        return;
      }
      syncAccepted(acSignal(), '判题轮询');
    }, 150);
    debug('开始轮询成功结果（最多 15 秒）');
  }

  // 网络探针读的是接口原始响应，比页面文本可靠；但同一个响应里可能同时带着
  // 题目以前通过的状态、历史提交列表、本次提交还在判题等：只要响应里出现失败或
  // 未出结果的迹象，就绝不能当成“这次提交通过了”。
  //
  // 探针报上来的每条响应都要带接口地址和原文片段：判断误报的唯一线索就是"哪条接口的
  // 响应里带着通过字样"，只报关键词根本看不出它属于哪次提交。被否决的响应（含通过字样
  // 但同时有失败/评测中迹象）也要报，否则看不出"探针先报通过、随后页面才判错"的先后。
  function installNetworkProbe() {
    var code = [
      '(function(){',
      'if(window.__codeAgendaProbe)return;window.__codeAgendaProbe=1;',
      'var sent={},rejected=0;',
      'function bad(s){return /(答案错误|部分正确|编译错误|运行错误|运行超时|内存超限|格式错误|段错误|浮点错误|返回非零|异常退出|多种错误|内部错误|等待评测|正在评测|评测中|判题中|Wrong\\s+Answer|Compile\\s+Error|Runtime\\s+Error|"isResultRight"\\s*:\\s*false)/i.test(s||"");}',
      'function ok(s){return !!s&&!bad(s)&&/(恭喜你通过本题|通过全部用例|答案正确|Accepted|"isResultRight"\\s*:\\s*true|"rightHundredRate"\\s*:\\s*100)/i.test(s);}',
      'function kw(s){var m=String(s||"").match(/恭喜你通过本题|通过全部用例|答案正确|Accepted|isResultRight|rightHundredRate/i);return m?m[0]:"";}',
      'function snip(s){var t=String(s||""),i=t.search(/恭喜你通过本题|通过全部用例|答案正确|Accepted|isResultRight|rightHundredRate/i);if(i<0)return t.slice(0,240);return t.slice(Math.max(0,i-80),i+200);}',
      'function send(type,url,s){try{var k=type+"|"+String(url||"");sent[k]=(sent[k]||0)+1;if(sent[k]>8)return;if(type==="rejected"){rejected+=1;if(rejected>60)return;}window.postMessage({source:"codeagenda-probe",type:type,keyword:kw(s),url:String(url||""),snippet:snip(s)},"*")}catch(e){}}',
      'function report(url,s){if(ok(s))send("accepted",url,s);else if(kw(s))send("rejected",url,s);}',
      'var of=window.fetch; if(of)window.fetch=function(){var u=arguments[0];return of.apply(this,arguments).then(function(r){try{r.clone().text().then(function(t){report((r&&r.url)||u,t)})}catch(e){}return r})};',
      'var os=XMLHttpRequest.prototype.open, od=XMLHttpRequest.prototype.send;',
      'XMLHttpRequest.prototype.open=function(m,u){this.__caUrl=u;return os.apply(this,arguments)};',
      'XMLHttpRequest.prototype.send=function(){var x=this;this.addEventListener("load",function(){try{report(x.__caUrl,x.responseText)}catch(e){}});return od.apply(this,arguments)};',
      '})()'
    ].join('');
    var script = document.createElement('script');
    script.textContent = code;
    var root = document.documentElement || document.head;
    if (!root) {
      document.addEventListener('DOMContentLoaded', installNetworkProbe, { once: true });
      return;
    }
    root.appendChild(script);
    script.remove();
  }

  var helper = {
    updateTodayRecord: updateTodayRecord,
    scan: scan,
    /* DEBUG API DISABLED - uncomment these entries when troubleshooting.
    debugDaily: debugDaily,
    debugAC: function () { DEBUG = true; var result = acSignal(); console.log('[CodeAgenda debug] AC 候选:', result || '(无)'); return result; },
    debugState: debugState,
    debugDatabase: debugDatabase,
    setDebug: function (enabled) { DEBUG = !!enabled; },
    */ // END DEBUG API
    mockDaily: function () { return updateTodayRecord(null, 1).then(function () { GM_setValue(DAILY_MARKER_KEY, today()); }); },
    mockAC: function () {
      return recordSubmission(problemKey());
    },
    // 日志是攒批发的，排查时想立刻要结果就用这两个：flushLog 立即发送，dumpLog 顺带打回控制台。
    flushLog: flushTrace,
    dumpLog: function () { flushTrace(); console.log(traceRing.join('\n')); return traceRing.slice(); }
  };
  // Tampermonkey grants run in an isolated sandbox; expose the helper to the page console too.
  window.syncHelper = helper;
  pageWindow.syncHelper = helper;
  pageWindow.__codeAgendaLoaded = true;

  var observer = new MutationObserver(function () { clearTimeout(observer.timer); observer.timer = setTimeout(scan, 350); });
  window.addEventListener('message', function (event) {
    if ((event.source !== pageWindow && event.source !== window) || !event.data || event.data.source !== 'codeagenda-probe') return;
    var data = event.data;
    if (data.type !== 'accepted' && data.type !== 'rejected') return;
    // 探针报的是整条响应，本脚本完全不知道它对应哪道题、哪次提交：接口地址和片段必须留痕。
    var fields = {
      关键词: data.keyword,
      接口: clip(data.url, 200),
      响应片段: clip(data.snippet, 300),
      距点击: sinceClick()
    };
    if (data.type === 'rejected') {
      trace('接口探针否决（响应含通过字样但也有失败/评测中迹象）', fields);
      return;
    }
    lastProbeSignal = data.keyword || 'accepted';
    log('网络探针检测到牛客通过响应:', lastProbeSignal);
    trace('接口探针命中通过', fields);
    syncAccepted('network:' + (data.keyword || 'accepted'), '接口探针');
  });
  // 只有"提交"按钮才算一次判题。牛客的"运行/自测"按钮跑完样例后，结果面板同样会冒出
  // "答案正确"，但那只是样例跑通、不是本题判通过；把它当成一次提交，就会出现
  // "自测对了就记成通过、随后提交判错也改不回来"。
  var NOT_SUBMIT_RE = /(运行|自测|执行代码|调试|我的提交|提交记录|提交次数|历史提交)/i;
  var SUBMIT_TEXT_RE = /(保存并提交|提交代码|提交答案|提交测评|提交)/i;
  var SUBMIT_CLASS_RE = /(btn-submit|submit-btnbox|submit-btn)/i;

  // 从点击处向上找几层，判断这次点击是不是"提交"。牛客部分版本用 div/span 当按钮，所以
  // 类名和文本都要看；碰到运行、自测、提交记录这类控件一律不算。
  // walk 收集沿途每一层命中的判定，供日志还原"这次点击为什么算/不算提交"。
  function clickedSubmitControl(element, walk) {
    for (var level = 0; element && level < 8; level += 1, element = element.parentElement) {
      var cls = element.className && typeof element.className === 'string' ? element.className : '';
      var label = textOf(element);
      if (label.length > 80) label = '';
      var notSubmit = NOT_SUBMIT_RE.test(cls) || NOT_SUBMIT_RE.test(label);
      var isSubmit = SUBMIT_CLASS_RE.test(cls) || SUBMIT_TEXT_RE.test(label);
      if (notSubmit || isSubmit) {
        if (walk) walk.push('第' + level + '层' + nodeInfo(element) + (notSubmit ? '→不算提交' : '→算提交'));
      }
      if (notSubmit) return null;
      if (isSubmit) return element;
    }
    return null;
  }

  function start() {
    if (!document.body) return;
    // installDebugPanel(); // Debug panel disabled for normal use.
    // 先监听动态结果，再在 2.5 秒后做首次扫描；首次扫描只建立 AC 提示基线。
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    acReady = true;
    trace('脚本启动', { 版本: SCRIPT_VERSION, 页面: location.href, 题目: problemKey() });
    document.addEventListener('click', function (event) {
      var walk = [];
      var control = clickedSubmitControl(event.target, walk);
      // 只有这条点击链路上出现过"提交/运行/自测"字样的才值得记，否则点页面任意处都会留一行。
      if (walk.length) {
        trace(control ? '点击判定：算提交' : '点击判定：不算提交', {
          点击目标: nodeInfo(event.target),
          逐层判定: walk.join(' | ')
        });
      }
      if (!control) return;
      debug('检测到提交操作，等待判题结果:', textOf(control).slice(0, 120));
      beginAttempt('点击提交控件');
    }, true);
    document.addEventListener('keydown', function (event) {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        debug('检测到 Ctrl/Cmd+Enter 提交操作，等待判题结果');
        beginAttempt('Ctrl/Cmd+Enter');
      }
    }, true);
    setTimeout(function () {
      syncTrackerDailyProblem();
      log('自动同步已启动');
    }, 2500);
  }
  installNetworkProbe();
  // 离开页面（关标签/跳转）前把还攒着的日志发出去，否则最后几条判定链路会随页面一起没。
  window.addEventListener('pagehide', function () {
    trace('页面卸载', { 距点击: sinceClick(), 仍处武装状态: submissionArmed ? '是' : '否' });
    flushTrace();
  });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'hidden') return;
    trace('页面切到后台', { 距点击: sinceClick(), 仍处武装状态: submissionArmed ? '是' : '否' });
    flushTrace();
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
