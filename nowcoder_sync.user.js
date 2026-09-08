// ==UserScript==
// @name         CodeAgenda - 牛客刷题同步
// @namespace    codeagenda.local
// @version      1.2.0
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
  var DEBUG = true;

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
      return request('GET', '/api/submissions?date=' + encodeURIComponent(ds)).then(function (submissions) {
        var row = (records.records || []).find(function (r) { return r.date === ds; }) || null;
        var result = { date: ds, record: row, submissions: submissions.submissions || [], currentProblemKey: problemKey() };
        console.log('[CodeAgenda debug] 本地数据库诊断:', result);
        console.table(result.submissions);
        return result;
      });
    }).catch(function (error) {
      console.error('[CodeAgenda debug] 本地数据库请求失败:', error);
      throw error;
    });
  }

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
        ' | 请求：' + (lastRequestResponse || lastRequestError || '未发送');
    }
    document.getElementById('codeagenda-check').addEventListener('click', function () { showState(); debugDaily(); });
    document.getElementById('codeagenda-db').addEventListener('click', function () {
      text.textContent = '正在读取本地数据库...';
      debugDatabase().then(function (r) {
        var found = (r.submissions || []).some(function (x) { return x.problem_key === r.currentProblemKey; });
        text.textContent = '数据库连接成功 | 今日汇总：' + (r.record ? r.record.count + ' 题' : '无记录') + ' | 本题数据库状态：' + (found ? '已有记录（本次不会增加）' : '无记录（下次真实提交成功会增加）');
      }).catch(function (e) { text.textContent = '数据库连接失败：' + e.message; });
    });
    showState();
    setInterval(showState, 500);
  }

  function acSignal() {
    var successRe = /(答案正确|提交成功|恭喜你通过本题|通过本题|用例通过|全部通过|测试通过|Accepted|\bAC\b|运行成功|编译成功)/i;
    // 牛客通过弹窗由自定义组件动态插入，优先从页面可见文本整体查找精确成功短语。
    var pageText = document.body ? (document.body.innerText || '') : '';
    var debugPanel = document.getElementById('codeagenda-debug-panel');
    if (debugPanel && debugPanel.innerText) pageText = pageText.replace(debugPanel.innerText, '');
    var pageMatch = pageText.match(successRe);
    if (pageMatch && !/(通过率|提交次数|历史通过|通过人数)/i.test(pageMatch[0])) return pageMatch[0];
    var nodes = document.querySelectorAll('body *');
    for (var i = 0; i < nodes.length; i += 1) {
      if (isIgnoredNode(nodes[i]) || !isVisible(nodes[i])) continue;
      var text = textOf(nodes[i]);
      if (/(通过率|提交次数|历史通过|通过人数)/i.test(text)) continue;
      var match = text.match(successRe);
      if (match) {
        var start = Math.max(0, match.index - 40);
        return text.slice(start, start + 160);
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

  function syncDaily() {
    if (dailySyncInFlight || GM_getValue(DAILY_MARKER_KEY, '') === today() || !isDailyComplete()) return;
    dailySyncInFlight = true;
    log('检测到今日每日一题已完成');
    updateTodayRecord(null, 1).then(function () {
      GM_setValue(DAILY_MARKER_KEY, today());
    }).catch(function () {}).then(function () { dailySyncInFlight = false; });
  }

  function syncAccepted(signal) {
    var now = Date.now();
    lastWatchSignal = signal || '';
    lastGateInfo = 'ready=' + acReady + ', armed=' + submissionArmed + ', signal=' + (!!signal) + ', inFlight=' + acSyncInFlight + ', cooldown=' + (now - lastAcSyncAt < AC_COOLDOWN_MS);
    debug('AC 检查:', lastGateInfo, signal || '(无成功提示)');
    if (!acReady || !submissionArmed || !signal || acSyncInFlight || now - lastAcSyncAt < AC_COOLDOWN_MS) return;
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
      return result;
    }).catch(function (error) {
      // 请求失败时允许后续相同结果重试。
      seenAcSignals.delete(eventKey);
      log('AC 同步失败:', error.message);
    }).then(function () { acSyncInFlight = false; });
  }

  function scan() {
    syncDaily();
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

  function installNetworkProbe() {
    var code = '(function(){' +
      'if(window.__codeAgendaProbe)return;window.__codeAgendaProbe=1;' +
      'function ok(s){return /(恭喜你通过本题|通过全部用例|答案正确|Accepted|"isResultRight"\\s*:\\s*true|"rightHundredRate"\\s*:\\s*100)/i.test(s||"");}' +
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
    debugDaily: debugDaily,
    debugAC: function () { DEBUG = true; var result = acSignal(); console.log('[CodeAgenda debug] AC 候选:', result || '(无)'); return result; },
    debugState: debugState,
    debugDatabase: debugDatabase,
    setDebug: function (enabled) { DEBUG = !!enabled; },
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
    installDebugPanel();
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
        submissionArmed = true;
        lastSubmitAt = new Date().toLocaleTimeString();
        debug('检测到提交操作，等待成功结果:', text.trim().slice(0, 120));
        watchForSuccess();
      }
    }, true);
    document.addEventListener('keydown', function (event) {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        submissionArmed = true;
        lastSubmitAt = new Date().toLocaleTimeString();
        debug('检测到 Ctrl/Cmd+Enter 提交操作，等待成功结果');
        watchForSuccess();
      }
    }, true);
    setTimeout(function () {
      syncDaily();
      log('自动同步已启动');
    }, 2500);
  }
  installNetworkProbe();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
