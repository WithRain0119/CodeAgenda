// ==UserScript==
// @name         CodeAgenda - 牛客刷题同步
// @namespace    codeagenda.local
// @version      1.4.0
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
  var seenAcSignals = new Set();
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
      seenSignals: Array.from(seenAcSignals)
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

  function baselined(item) {
    return !!attemptBaseline && attemptBaseline.get(item.node) === item.text;
  }

  function beginAttempt() {
    attemptBaseline = new Map();
    attemptFailed = false;
    var current = scanSignals();
    var items = current.pass.concat(current.fail, current.pending);
    for (var i = 0; i < items.length; i += 1) attemptBaseline.set(items[i].node, items[i].text);
    submissionArmed = true;
    lastSubmitAt = new Date().toLocaleTimeString();
    watchForSuccess();
  }

  // 本次提交的通过提示：基线里就有的、还在判题的、已经判失败的一律不算。
  function acSignal() {
    if (!attemptBaseline) return '';
    var current = scanSignals();
    var i;
    for (i = 0; i < current.fail.length; i += 1) {
      if (!baselined(current.fail[i]) && !attemptFailed) {
        attemptFailed = true;
        debug('本次提交已判失败:', current.fail[i].signal);
      }
    }
    if (attemptFailed) return '';
    for (i = 0; i < current.pending.length; i += 1) {
      if (!baselined(current.pending[i])) {
        debug('本次提交还在判题中:', current.pending[i].signal);
        return '';
      }
    }
    for (i = 0; i < current.pass.length; i += 1) {
      if (!baselined(current.pass[i])) return current.pass[i].signal;
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
    request('POST', '/api/daily-problems', { date: today(), title: title, url: url }).then(function (data) {
      dailyDebug.result = 'Tracker 保存成功';
      debug('Tracker 每日一题保存响应:', data);
    }).catch(function (error) {
      trackerDailyKey = '';
      dailyDebug.error = error.message;
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
        log('当前通过题不是今日每日一题:', currentProblemUrl(), p ? canonicalUrl(p.url) : '(未记录)');
        return false;
      }
      dailyDebug.match = '匹配';
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

  function syncAccepted(signal) {
    var now = Date.now();
    lastWatchSignal = signal || '';
    lastGateInfo = 'ready=' + acReady + ', armed=' + submissionArmed + ', signal=' + (!!signal) + ', inFlight=' + acSyncInFlight + ', cooldown=' + (now - lastAcSyncAt < AC_COOLDOWN_MS) + ', failed=' + attemptFailed;
    debug('AC 检查:', lastGateInfo, signal || '(无成功提示)');
    if (!acReady || !submissionArmed || !signal || acSyncInFlight || attemptFailed || now - lastAcSyncAt < AC_COOLDOWN_MS) return;
    var key = normalizeSignal(signal);
    var problem = today() + '|' + problemKey();
    var eventKey = problem + '|' + key;
    // The local database is authoritative. Browser storage is not used to decide
    // whether a problem was counted, so an old NowCoder submission can be counted
    // when it is first submitted after CodeAgenda was installed.
    if (seenAcSignals.has(eventKey)) return;
    seenAcSignals.add(eventKey);
    acSyncInFlight = true;
    if (successWatchTimer) { clearInterval(successWatchTimer); successWatchTimer = null; }
    lastAcSyncAt = now;
    lastSuccessSignal = key;
    lastSuccessAt = new Date().toLocaleTimeString();
    log('检测到代码提交成功:', key);
    recordSubmission(problemKey()).then(function (result) {
      if (result.duplicate) log('该题今天已经计数，跳过重复提交');
      submissionArmed = false;
      return markDailyIfMatched().catch(function (error) { log('每日一题匹配失败:', error.message); return false; }).then(function () { return result; });
    }).catch(function (error) {
      // 请求失败时允许后续相同结果重试。
      seenAcSignals.delete(eventKey);
      log('AC 同步失败:', error.message);
    }).then(function () { acSyncInFlight = false; });
  }

  function scan() {
    syncTrackerDailyProblem();
    syncAccepted(acSignal());
  }

  function watchForSuccess() {
    if (successWatchTimer) clearInterval(successWatchTimer);
    var started = Date.now();
    watchAttempts = 0;
    successWatchTimer = setInterval(function () {
      watchAttempts += 1;
      if (Date.now() - started > 15000 || !submissionArmed) {
        clearInterval(successWatchTimer);
        successWatchTimer = null;
        return;
      }
      syncAccepted(acSignal());
    }, 150);
    debug('开始轮询成功结果（最多 15 秒）');
  }

  // 网络探针读的是接口原始响应，比页面文本可靠；但同一个响应里可能同时带着
  // 题目以前通过的状态、历史提交列表、本次提交还在判题等：只要响应里出现失败或
  // 未出结果的迹象，就绝不能当成“这次提交通过了”。
  function installNetworkProbe() {
    var code = '(function(){' +
      'if(window.__codeAgendaProbe)return;window.__codeAgendaProbe=1;' +
      'function bad(s){return /(答案错误|部分正确|编译错误|运行错误|运行超时|内存超限|格式错误|段错误|浮点错误|返回非零|异常退出|多种错误|内部错误|等待评测|正在评测|评测中|判题中|Wrong\\s+Answer|Compile\\s+Error|Runtime\\s+Error|"isResultRight"\\s*:\\s*false)/i.test(s||"");}' +
      'function ok(s){return !!s&&!bad(s)&&/(恭喜你通过本题|通过全部用例|答案正确|Accepted|"isResultRight"\\s*:\\s*true|"rightHundredRate"\\s*:\\s*100)/i.test(s);}' +
      'function send(s){try{window.postMessage({source:"codeagenda-probe",type:"accepted",signal:String(s).match(/恭喜你通过本题|通过全部用例|答案正确|Accepted|isResultRight|rightHundredRate/i)[0]},"*")}catch(e){}}' +
      'var of=window.fetch; if(of)window.fetch=function(){return of.apply(this,arguments).then(function(r){try{r.clone().text().then(function(t){if(ok(t))send(t)})}catch(e){}return r})};' +
      'var os=XMLHttpRequest.prototype.open, od=XMLHttpRequest.prototype.send;' +
      'XMLHttpRequest.prototype.open=function(m,u){this.__caUrl=u;return os.apply(this,arguments)};' +
      'XMLHttpRequest.prototype.send=function(){this.addEventListener("load",function(){try{if(ok(this.responseText))send(this.responseText)}catch(e){}});return od.apply(this,arguments)};' +
    '})()';
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
    }
  };
  // Tampermonkey grants run in an isolated sandbox; expose the helper to the page console too.
  window.syncHelper = helper;
  pageWindow.syncHelper = helper;
  pageWindow.__codeAgendaLoaded = true;

  var observer = new MutationObserver(function () { clearTimeout(observer.timer); observer.timer = setTimeout(scan, 350); });
  window.addEventListener('message', function (event) {
    if ((event.source !== pageWindow && event.source !== window) || !event.data || event.data.source !== 'codeagenda-probe' || event.data.type !== 'accepted') return;
    lastProbeSignal = event.data.signal || 'accepted';
    log('网络探针检测到牛客通过响应:', event.data.signal || '(success)');
    syncAccepted('network:' + (event.data.signal || 'accepted'));
  });
  function start() {
    if (!document.body) return;
    // installDebugPanel(); // Debug panel disabled for normal use.
    // 先监听动态结果，再在 2.5 秒后做首次扫描；首次扫描只建立 AC 提示基线。
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    acReady = true;
    document.addEventListener('click', function (event) {
      if (event.target && event.target.closest && event.target.closest('#codeagenda-debug-panel')) return;
      var target = event.target;
      var text = '';
      // 牛客部分版本使用 div/span 作为提交按钮，向上检查几层可点击容器。
      for (var level = 0; target && level < 8; level += 1, target = target.parentElement) {
        var candidate = textOf(target);
        if (candidate && candidate.length <= 80) text += ' ' + candidate;
        var cls = target.className && typeof target.className === 'string' ? target.className : '';
        if (/(btn-submit|confirm-btn|submit-btnbox|run-code|runCode)/i.test(cls) ||
            /(提交代码|提交答案|提交|运行代码|运行|执行代码|submit|run)/i.test(candidate || '')) break;
      }
      var clickedClass = event.target && event.target.closest ? event.target.closest('.btn-submit, .confirm-btn, .submit-btnbox, [class*="run-code"]') : null;
      if (clickedClass || /(提交代码|提交答案|提交|运行代码|运行|执行代码|submit|run)/i.test(text)) {
        debug('检测到提交操作，等待判题结果:', text.trim().slice(0, 120));
        beginAttempt();
      }
    }, true);
    document.addEventListener('keydown', function (event) {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        debug('检测到 Ctrl/Cmd+Enter 提交操作，等待判题结果');
        beginAttempt();
      }
    }, true);
    setTimeout(function () {
      syncTrackerDailyProblem();
      log('自动同步已启动');
    }, 2500);
  }
  installNetworkProbe();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
