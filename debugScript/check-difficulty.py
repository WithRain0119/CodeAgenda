# 题目难度字段的回归校验：数据库迁移 + 接口契约 + 备份往返。
#
# 运行：py debugScript/check-difficulty.py      （只用标准库，无需 pytest；退出码 0 = 全部符合预期）
#
# 为什么要有这个文件：给 submissions 加 difficulty 是项目里第一处 schema 迁移，一次改到了建表（两处）、
# 旧库搬迁、写入、读取、导出、导入这些**显式列名**的地方。任何一处漏改，轻则前端读不到难度、备份丢字段，
# 重则旧库搬迁时列数不匹配直接抛错、带旧库的用户起不来服务。这里把每条路径都固定住。
#
# 全程只操作临时目录里的库：运行期覆盖 app 的路径常量（app 内部都是调用时才读它们），绝不碰 data/*.db。

import logging
import os
import shutil
import sqlite3
import sys
import tempfile

# Windows 控制台默认 GBK，编不出 ✓/✗ 会直接抛 UnicodeEncodeError；统一切到 UTF-8 输出，
# 与同目录下 Node 写的 drive-userscript.js 保持一致。
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE_DIR)
import app as A  # noqa: E402

REAL_DATA_DIR = os.path.join(BASE_DIR, 'data')
TMP_DIR = tempfile.mkdtemp(prefix='codeagenda-difficulty-')

# 加 difficulty 之前 submissions 的原始建表语句，用来造"老库"。
OLD_SUBMISSIONS_DDL = '''CREATE TABLE submissions (
    id TEXT PRIMARY KEY, date TEXT NOT NULL, problem_key TEXT NOT NULL,
    created_at TEXT, UNIQUE(date, problem_key))'''

failures = 0


def check(label, ok, detail=''):
    global failures
    if not ok:
        failures += 1
    print('  ' + ('✓' if ok else '✗') + ' ' + label + (('：' + str(detail)) if detail else ''))


def point_at_tmp():
    """把所有库路径指向临时目录。app 里这些常量都是调用时才读，所以运行期覆盖有效。"""
    A.DATA_DIR = TMP_DIR
    A.RECORDS_DB_PATH = os.path.join(TMP_DIR, 'records.db')
    A.DETAILS_DB_PATH = os.path.join(TMP_DIR, 'details.db')
    A.LEGACY_DB_PATH = os.path.join(TMP_DIR, 'no-such-legacy.db')  # 不存在 = 不触发旧库搬迁
    # 自检：任何一条路径跑到临时目录外面就立刻停，绝不冒写真实数据的风险。
    for path in (A.RECORDS_DB_PATH, A.DETAILS_DB_PATH, A.LEGACY_DB_PATH):
        assert os.path.abspath(path).startswith(os.path.abspath(TMP_DIR)), path
    assert os.path.abspath(REAL_DATA_DIR) != os.path.abspath(TMP_DIR)


def fresh():
    """清掉临时目录里的库，回到"什么都没建"的状态。"""
    for name in ('records.db', 'details.db'):
        path = os.path.join(TMP_DIR, name)
        if os.path.isfile(path):
            os.remove(path)


def columns(db_path, table):
    conn = sqlite3.connect(db_path)
    try:
        return {row[1] for row in conn.execute('PRAGMA table_info(%s)' % table)}
    finally:
        conn.close()


def rows(db_path, sql, params=()):
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        return conn.execute(sql, params).fetchall()
    finally:
        conn.close()


point_at_tmp()

# 日志本身就是这次要交付的东西之一，所以要在测试里能断言它写了什么。
log_lines = []


class _Capture(logging.Handler):
    def emit(self, record):
        log_lines.append(record.getMessage())


A.log.addHandler(_Capture())

# ---- 一、迁移：全新库 / 重复执行 --------------------------------------------
print('\n一、迁移：全新库与重复执行')
fresh()
A.init_db()
check('新库的 submissions 自带 difficulty 列', 'difficulty' in columns(A.DETAILS_DB_PATH, 'submissions'))
try:
    A.init_db()
    check('重复 init_db 是空操作，不抛错', True)
except Exception as exc:  # noqa: BLE001
    check('重复 init_db 是空操作，不抛错', False, exc)

# ---- 二、迁移：已有老库补列 --------------------------------------------------
print('\n二、迁移：已有老库（submissions 无 difficulty 列）补列')
fresh()
conn = sqlite3.connect(A.DETAILS_DB_PATH)
conn.execute(OLD_SUBMISSIONS_DDL)
conn.execute("INSERT INTO submissions VALUES ('id1','2026-09-01','www.nowcoder.com/practice/a|甲','2026-09-01 10:00:00')")
conn.execute("INSERT INTO submissions VALUES ('id2','2026-09-02','www.nowcoder.com/practice/b|乙','2026-09-02 10:00:00')")
conn.commit()
conn.close()
A.init_db()
check('老库补出了 difficulty 列', 'difficulty' in columns(A.DETAILS_DB_PATH, 'submissions'))
old_rows = rows(A.DETAILS_DB_PATH, 'SELECT id, difficulty FROM submissions ORDER BY id')
check('老库原有 2 条一条没丢', len(old_rows) == 2, len(old_rows))
check('旧行的 difficulty 是 NULL（界面会显示难度未知）', all(r['difficulty'] is None for r in old_rows))

# ---- 三、迁移：旧版根目录 records.db 搬迁（列数不匹配的回归点）----------------
print('\n三、迁移：旧版 records.db 搬迁（本次改动最容易炸的一条路径）')
fresh()
legacy_path = os.path.join(TMP_DIR, 'legacy-root-records.db')
conn = sqlite3.connect(legacy_path)
conn.execute(OLD_SUBMISSIONS_DDL)  # 旧库的 submissions 只有 4 列
conn.execute("INSERT INTO submissions VALUES ('L1','2026-08-01','www.nowcoder.com/practice/l1|旧题','2026-08-01 09:00:00')")
conn.execute("INSERT INTO submissions VALUES ('L2','2026-08-02','www.nowcoder.com/practice/l2|旧题二','2026-08-02 09:00:00')")
conn.execute('''CREATE TABLE records (id TEXT PRIMARY KEY, date TEXT UNIQUE NOT NULL, count INTEGER NOT NULL DEFAULT 0,
                is_daily INTEGER NOT NULL DEFAULT 0, created_at TEXT, updated_at TEXT)''')
conn.execute("INSERT INTO records VALUES ('r1','2026-08-01',3,0,'x','x')")
conn.execute('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
conn.execute("INSERT INTO settings VALUES ('nowcoder','{}')")
conn.commit()
conn.close()
A.LEGACY_DB_PATH = legacy_path
try:
    A.init_db()
    check('搬迁不再因列数不匹配而抛错', True)
    moved = rows(A.DETAILS_DB_PATH, 'SELECT id, difficulty FROM submissions ORDER BY id')
    check('旧库 2 条 submissions 都搬过来了', len(moved) == 2, len(moved))
    check('搬迁进来的行 difficulty 为 NULL', all(r['difficulty'] is None for r in moved))
    check('records 也搬过来了', len(rows(A.RECORDS_DB_PATH, 'SELECT * FROM records')) == 1)
except Exception as exc:  # noqa: BLE001
    check('搬迁不再因列数不匹配而抛错', False, exc)
A.LEGACY_DB_PATH = os.path.join(TMP_DIR, 'no-such-legacy.db')

# ---- 四、迁移：真实库的副本 --------------------------------------------------
print('\n四、迁移：真实 data/details.db 的副本')
real_details = os.path.join(REAL_DATA_DIR, 'details.db')
if os.path.isfile(real_details):
    fresh()
    before = len(rows(real_details, 'SELECT id FROM submissions'))
    shutil.copy(real_details, A.DETAILS_DB_PATH)
    try:
        A.init_db()
        check('真实库副本补列成功', 'difficulty' in columns(A.DETAILS_DB_PATH, 'submissions'))
        check('真实库副本行数不变', len(rows(A.DETAILS_DB_PATH, 'SELECT id FROM submissions')) == before,
              '%d -> %d' % (before, len(rows(A.DETAILS_DB_PATH, 'SELECT id FROM submissions'))))
    except Exception as exc:  # noqa: BLE001
        check('真实库副本补列成功', False, exc)
else:
    print('  （跳过：本机没有真实库）')

# ---- 五、parse_difficulty ----------------------------------------------------
print('\n五、parse_difficulty 归一化')
check('去空白', A.parse_difficulty('  入门 ') == '入门')
check('空串 -> None', A.parse_difficulty('   ') is None)
check('非字符串 -> None', A.parse_difficulty(123) is None)
check('内部换行压成空格', A.parse_difficulty('较\n难') == '较 难')
check('超长截断到 32 字', len(A.parse_difficulty('难' * 50)) == 32, A.parse_difficulty('难' * 50)[:8] + '…')

# ---- 六、接口往返 ------------------------------------------------------------
print('\n六、接口：写入 / 读取 / 去重 / 删除')
fresh()
A.init_db()
client = A.app.test_client()
DAY = '2026-09-20'
URL_A = 'https://www.nowcoder.com/practice/aaa'

resp = client.post('/api/submissions', json={'date': DAY, 'problem_key': URL_A + '|温标转换',
                                             'difficulty': '入门', 'attempt_id': 'k-test-1'})
check('脚本形态（带难度）上报成功', resp.status_code == 200 and resp.get_json()['duplicate'] is False, resp.status_code)
items = client.get('/api/submissions').get_json()['submissions']
check('返回字段齐全（含 id，删除弹窗要用）',
      set(items[0]) == {'id', 'date', 'problem_key', 'created_at', 'difficulty', 'is_daily'}, sorted(items[0]))
check('难度存下来了', items[0]['difficulty'] == '入门', items[0]['difficulty'])

resp = client.post('/api/submissions', json={'date': DAY, 'problem_key': URL_A + '|温标转换',
                                             'difficulty': '困难', 'attempt_id': 'k-test-2'})
check('重复上报返回 duplicate', resp.get_json()['duplicate'] is True)
after = client.get('/api/submissions').get_json()['submissions']
check('已有难度不被覆盖（去重语义未变）', after[0]['difficulty'] == '入门', after[0]['difficulty'])
check('没有多出记录', len(after) == 1, len(after))

resp = client.post('/api/submissions', json={'date': DAY, 'problem_url': 'https://www.nowcoder.com/practice/bbb',
                                             'problem_title': '手填的题'})
check('手填形态仍能上报（无难度输入）', resp.status_code == 200, resp.status_code)
hand = [s for s in client.get('/api/submissions').get_json()['submissions']
        if 'practice/bbb' in s['problem_key']]
check('手填记录的难度为空', hand and hand[0]['difficulty'] is None, hand[0]['difficulty'] if hand else '无记录')

client.post('/api/submissions', json={'date': DAY, 'problem_key': 'https://www.nowcoder.com/practice/ccc|非字符串难度',
                                      'difficulty': 123, 'attempt_id': 'k-test-3'})
client.post('/api/submissions', json={'date': DAY, 'problem_key': 'https://www.nowcoder.com/practice/ddd|空白难度', 'difficulty': '   '})
odd = {s['problem_key'].split('|')[-1]: s['difficulty']
       for s in client.get('/api/submissions').get_json()['submissions']
       if 'practice/ccc' in s['problem_key'] or 'practice/ddd' in s['problem_key']}
check('非法难度不写脏数据，记录本身照常写入', len(odd) == 2 and all(v is None for v in odd.values()), odd)

# ---- 七、导出 / 导入 ---------------------------------------------------------
print('\n七、导出 / 导入')
exported = client.get('/api/export').get_json()
check('导出的每条 submissions 都带 difficulty 键',
      all('difficulty' in s for s in exported['submissions']), len(exported['submissions']))
for sub in exported['submissions']:
    sub.pop('difficulty', None)  # 模拟"加字段之前导出的老备份"
resp = client.post('/api/import', json=exported)
check('老备份（没有 difficulty 键）能导入', resp.status_code == 200, resp.status_code)
kept = [s for s in client.get('/api/submissions').get_json()['submissions'] if 'practice/aaa' in s['problem_key']]
check('导入老备份没有抹掉已有难度', kept and kept[0]['difficulty'] == '入门', kept[0]['difficulty'] if kept else '无记录')

# ---- 八、删除与旧接口 --------------------------------------------------------
print('\n八、删除与其它接口未受影响')
first_id = client.get('/api/submissions').get_json()['submissions'][0]['id']
resp = client.delete('/api/submissions/' + first_id)
check('删除接口照常工作', resp.status_code == 200, resp.status_code)
for path in ('/api/records', '/api/summary', '/api/daily-problems?date=' + DAY, '/api/settings'):
    resp = client.get(path)
    check('GET ' + path.split('?')[0] + ' 正常', resp.status_code == 200, resp.status_code)

# ---- 九、parse_attempt_id ---------------------------------------------------
print('\n九、parse_attempt_id 校验（只用于日志对账，不入库）')
check('合法 id 原样返回', A.parse_attempt_id('k1-ab') == 'k1-ab')
check('非字符串 -> 丢空', A.parse_attempt_id(123) == '')
check('带空格/分号等字符 -> 丢空（不让外部输入污染日志）', A.parse_attempt_id('k1 ab;drop') == '')
check('超长 -> 丢空', A.parse_attempt_id('k' * 40) == '')
check('空串 -> 丢空', A.parse_attempt_id('') == '')

# ---- 十、日志内容 -----------------------------------------------------------
print('\n十、日志内容（这次改动的交付物，逐条验）')


def has_log(*needles):
    return any(all(n in line for n in needles) for line in log_lines)


check('迁移写了补列日志', has_log('数据库迁移：submissions 表补列 difficulty'),
      (log_lines and next((l for l in log_lines if '数据库迁移' in l), '(无)')) or '(无)')
check('新增通过题目：记了链路 id、难度、链接',
      has_log('新增通过题目', '链路=k-test-1', '难度=入门', 'practice/aaa'))
check('重复提交：记了命中哪条已有记录、什么时候建的',
      has_log('重复提交', '链路=k-test-2', '命中当天已有记录(创建于'))
check('难度不可用：记下了原值，便于回查脚本抓到了什么',
      has_log('上报的难度不可用', '原值=123'))
check('导入完成：各表条数分开记，能看出"忽略重复"和"跳过无效"的区别',
      has_log('导入完成', 'records 写入', 'submissions 新增', '已存在忽略', 'daily_problems 写入'))
check('请求日志能带上链路 id', has_log('POST /api/submissions', '链路=k-test-1'))

print('\n' + ('有 %d 项不符合预期' % failures if failures else '全部检查通过'))
process_exit = 1 if failures else 0
shutil.rmtree(TMP_DIR, ignore_errors=True)
sys.exit(process_exit)
