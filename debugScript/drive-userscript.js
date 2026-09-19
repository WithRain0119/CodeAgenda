// 判定链路回归测试：用最小假 DOM 驱动 nowcoder_sync.user.js，走完"点击 → 判题 → 记账"的各条分支。
//
// 运行：node debugScript/drive-userscript.js      （只用 Node 内置模块，无需 npm install）
// 退出码：0 = 所有场景都符合预期；1 = 有场景和记录的预期不一致。适合改判定逻辑后跑一遍。
//
// 为什么要有这个文件：脚本跑在牛客页面里，出了"没通过却记成通过"这类问题，只靠网页日志
// 很难复现（要真的去提交、去自测、还要等判题）。这里把 DOM、接口和时钟都做成假的，
// 让每个可疑路径都能稳定重放。2026-09-19 好多次方被误记的问题就是场景五复现出来的。
//
// 场景五（误记）和场景四（自测）是"特征测试"：记录的是当前实现的行为，不是期望的正确行为。
// 哪天把误报修好了，场景五会在输出里提示翻转，照着改成"不应记账"即可。

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'nowcoder_sync.user.js'), 'utf8');

// ---- 最小假 DOM ------------------------------------------------------------
function makeDom() {
  const all = [];
  function El(tag, cls, text, children) {
    const el = {
      tagName: tag.toUpperCase(), className: cls || '', nodeType: 1,
      childNodes: [], children: [], parentElement: null, raw: '',
      getBoundingClientRect: () => ({ width: 100, height: 20 }),
      getAttribute: () => null, closest: () => null,
      appendChild(c) { c.parentElement = el; el.children.push(c); el.childNodes.push(c); return c; },
      removeChild(c) {
        el.children = el.children.filter((x) => x !== c);
        el.childNodes = el.childNodes.filter((x) => x !== c);
        c.parentElement = null;
        return c;
      },
      remove() {},
    };
    for (const c of children || []) el.appendChild(c);
    if (text !== undefined) el.childNodes.push({ nodeType: 3, nodeValue: text });
    // script.textContent = code 这类赋值也要接住，否则假 DOM 一碰就崩。
    Object.defineProperty(el, 'textContent', {
      get: () => collect(el),
      set: (v) => { el.childNodes = []; el.children = []; el.raw = v; },
    });
    Object.defineProperty(el, 'innerText', { get: () => collect(el) });
    all.push(el);
    return el;
  }
  function collect(el) {
    let out = '';
    for (const n of el.childNodes) out += n.nodeType === 3 ? n.nodeValue : collect(n);
    return out;
  }
  return { El, all };
}
const { El, all } = makeDom();

const body = El('body', '', '');
const heading = El('h1', '', 'HIGH19 好多次方');
const submitBtn = El('div', 'btn-submit', '提交');
const runBtn = El('div', 'btn-run', '自测运行');
const panel = El('div', 'result-panel', '', [submitBtn, runBtn]);
body.appendChild(El('div', 'question', '', [heading, panel]));

const listeners = { click: [], keydown: [], message: [], pagehide: [], visibilitychange: [] };
const documentStub = {
  body, documentElement: El('html'), head: El('head'), readyState: 'complete',
  title: 'HIGH19 好多次方_牛客网', visibilityState: 'visible',
  createElement: (t) => El(t),
  addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
  querySelector: (sel) => (sel.indexOf('h1') === 0 ? heading : null),
  querySelectorAll: (sel) => (sel === 'body *' ? all.filter((e) => e !== body) : []),
};
const windowStub = {
  addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
  getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
  postMessage: () => {},
};

// ---- 假后端：拦下脚本的所有请求，按路径返回可预期的响应 ----------------------
const httpCalls = [];
let traceStatus = 200;       // 改成 404 可模拟"后端还没重启到新版"
let submitCount = 0;
const gm = {
  GM_xmlhttpRequest: (opts) => {
    const apiPath = opts.url.replace('http://127.0.0.1:5000', '');
    httpCalls.push({ method: opts.method, path: apiPath, body: opts.data });
    let status = 200;
    let payload = { duplicate: false, record: { count: 1 } };
    if (apiPath === '/api/client-log') {
      status = traceStatus;
      payload = status === 200 ? { saved: 1 } : { error: 'not found' };
    } else if (apiPath === '/api/submissions') {
      submitCount += 1;
      payload = { duplicate: false, record: { count: submitCount } };
    } else if (apiPath.indexOf('/api/daily-problems') === 0) {
      payload = { problems: [] };
    }
    setTimeout(() => { if (opts.onload) opts.onload({ status, responseText: JSON.stringify(payload) }); }, 0);
  },
  GM_getValue: () => '', GM_setValue: () => {},
};

// 判题冷却 5 秒会挡住"同一道题再通过一次"的复现，所以要把时钟往前拨。
// 只伪造 Date.now（脚本的冷却判断用它），真实定时器照旧，不然异步时序就乱了。
const RealDate = Date;
let clockOffset = 0;
function FakeDate(...args) { return args.length ? new RealDate(...args) : new RealDate(RealDate.now() + clockOffset); }
FakeDate.now = () => RealDate.now() + clockOffset;
FakeDate.prototype = RealDate.prototype;

const sandbox = {
  window: windowStub, document: documentStub,
  location: {
    href: 'https://www.nowcoder.com/practice/8bf1186260634b209b5cff362da45305',
    pathname: '/practice/8bf1186260634b209b5cff362da45305',
    host: 'www.nowcoder.com', origin: 'https://www.nowcoder.com',
  },
  MutationObserver: function () { this.observe = () => {}; },
  XMLHttpRequest: function () {}, navigator: { userAgent: 'test' },
  URL, console, setTimeout, clearTimeout, setInterval, clearInterval, Date: FakeDate,
  Promise, Map, Set, JSON, String, Number, Array, Object, RegExp, Error, Math,
  ...gm,
};
sandbox.XMLHttpRequest.prototype = { open() {}, send() {} };
sandbox.window.window = sandbox.window;
sandbox.window.document = documentStub;
vm.createContext(sandbox);
console.warn = (msg) => { console.log('   [控制台警告]', String(msg).slice(0, 90)); };
vm.runInContext(SRC, sandbox);

// ---- 取日志与计数 ----------------------------------------------------------
let subs = 0;
const traces = [];
function reset() {
  subs = 0;
  traces.length = 0;
  httpCalls.length = 0;
}
function takeTraces() {
  sandbox.window.syncHelper.flushLog();   // 日志是攒批发的，测试里手动催一下
  for (const call of httpCalls) {
    if (call.path === '/api/client-log') {
      for (const e of JSON.parse(call.body).events) traces.push(e.line);
    } else if (call.path === '/api/submissions') {
      subs += 1;   // 必须先统计再清空，否则数出来永远是 0
    }
  }
  httpCalls.length = 0;
  return traces.slice();
}
const click = (target) => listeners.click.forEach((fn) => fn({ target, ctrlKey: false }));
// 模拟页面里的网络探针：探针跑在页面上下文，只能通过 postMessage 把结果传回来。
const probe = (keyword, url) => listeners.message.forEach((fn) => fn({
  source: sandbox.window,
  data: {
    source: 'codeagenda-probe', type: 'accepted', keyword,
    url: url || 'https://www.nowcoder.com/api/submission/self-test',
    snippet: '{"msg":"' + keyword + '"}',
  },
}));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures += 1;
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + label + (detail ? '：' + detail : ''));
}

(async () => {
  console.log('场景一：点提交 → 判错，不应记账');
  await wait(60); reset();
  click(submitBtn);
  body.appendChild(El('div', 'verdict', '答案错误'));   // 判错结果渲染出来
  await wait(200);   // 等一次判题轮询（150ms）扫到这条结果
  console.log(takeTraces().filter((l) => /失败|拦下|记账/.test(l)).join('\n'));
  check('判错没有记账', subs === 0, '上报 ' + subs + ' 次');
  body.removeChild(body.children[body.children.length - 1]);

  console.log('\n场景二：点提交 → 通过 → 记账');
  clockOffset += 6000; reset();
  click(submitBtn);
  probe('答案正确');
  await wait(60);
  console.log(takeTraces().join('\n'));
  check('通过记了一条', subs === 1, '上报 ' + subs + ' 次');

  console.log('\n场景三：删掉记录后再通过一次（1.6.0 之前被内存去重挡掉）');
  clockOffset += 6000; reset();
  click(submitBtn);
  probe('答案正确');
  await wait(60);
  console.log(takeTraces().join('\n'));
  check('重新上报了', subs === 1, '上报 ' + subs + ' 次');

  console.log('\n场景四：只点"自测运行"（前面刚记过账），不应记账');
  clockOffset += 6000; reset();
  click(runBtn);
  probe('答案正确');
  await wait(60);
  console.log(takeTraces().join('\n'));
  check('自测没有记账', subs === 0, '上报 ' + subs + ' 次');

  console.log('\n场景五：点提交 → 结果没被识别 → 再点自测通过（2026-09-19 误报现场·特征测试）');
  clockOffset += 6000; reset();
  click(submitBtn);   // 这次提交既没记账，也没识别到判错文本（提交被拦下、或文案没匹配上）
  await wait(60);
  click(runBtn);      // 回头点自测，样例跑通
  probe('答案正确');
  await wait(60);
  console.log(takeTraces().join('\n'));
  console.log('  上报次数:', subs, subs === 0 ? '（误报已被修复）' : '（当前实现会误记）');
  check('行为与记录的特征一致', subs === 1 || subs === 0, subs === 0
    ? '误报已经修好，可以把本场景改成断言 subs === 0'
    : '误记仍在：自测的答案正确被算成了本题通过');

  console.log('\n场景六：后端没重启到新版（日志上报 404），日志不应丢失');
  clockOffset += 6000; reset();
  traceStatus = 404;
  click(submitBtn);
  probe('答案正确');
  sandbox.window.syncHelper.flushLog();   // 强制立刻上报，不等攒批
  await wait(60);
  const attempt404 = httpCalls.filter((c) => c.path === '/api/client-log').length;
  check('404 期间确实尝试过上报', attempt404 >= 1, '尝试 ' + attempt404 + ' 次');
  traceStatus = 200;
  httpCalls.length = 0;
  sandbox.window.syncHelper.flushLog();   // 等价于退避重试 / 下一次攒批
  await wait(60);
  const recovered = httpCalls.filter((c) => c.path === '/api/client-log' && c.body.indexOf('判定通过并记账') >= 0);
  check('后端恢复后补发成功', recovered.length > 0, recovered.length ? '日志没丢' : '日志丢了');

  console.log('\n' + (failures ? '有 ' + failures + ' 项不符合预期' : '全部场景符合记录的行为'));
  process.exit(failures ? 1 : 0);
})();
