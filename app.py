# -*- coding: utf-8 -*-
"""牛客刷题记录本地网页工具 —— Flask 后端 + SQLite。"""
import json
import logging
import os
import re
import sqlite3
import sys
import time
import uuid
from datetime import datetime, date, timedelta
from urllib.parse import urlsplit

from flask import Flask, jsonify, request, render_template, g
from werkzeug.exceptions import HTTPException

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, 'data')
RECORDS_DB_PATH = os.path.join(DATA_DIR, 'records.db')
DETAILS_DB_PATH = os.path.join(DATA_DIR, 'details.db')
LEGACY_DB_PATH = os.path.join(BASE_DIR, 'records.db')
BG_DIR = os.path.join(BASE_DIR, 'static', 'backgrounds')
BG_URL_PREFIX = '/static/backgrounds/'
ALLOWED_IMG_EXT = ('.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.avif')
MAX_BG_SIZE = 20 * 1024 * 1024  # 20MB

# 日志统一走 stdout（托盘会把子进程的 stdout/stderr 合并后显示在日志窗口里）。
# 这里在 import 期就占住 root handler：werkzeug 首次记请求日志时会检查“向上层是否已有 handler”，
# 发现已有就不再挂它自带的那个无格式 StreamHandler，于是两边格式一致、同一行也不会打两遍。
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%H:%M:%S',
    stream=sys.stdout,
)
log = logging.getLogger('codeagenda')
# werkzeug 的 INFO 级请求行（"127.0.0.1 - - [...] GET /api/x ..."）会被 root 套上上面的格式再打一遍，
# 而我们自己的请求日志已经带了方法/路径/状态/耗时，信息更全。所以把 werkzeug 压到 WARNING：
# 请求行不再重复，它真正的警告（如“不要用于生产环境”）和错误仍会保留。
logging.getLogger('werkzeug').setLevel(logging.WARNING)

# 主页面每 5 秒轮询这三个接口。成功时一律不记，否则每 5 秒 3 行会把真正有用的日志刷掉；
# 失败（>=400）仍然记录，因为那正是需要排查的情况。
POLLING_PATHS = frozenset(('/api/records', '/api/summary', '/api/submissions'))

app = Flask(__name__)


@app.before_request
def mark_request_start():
    g.request_started = time.perf_counter()


@app.after_request
def log_request_summary(response):
    """记录每个请求的方法、路径、状态码与耗时；轮询类 GET 成功时跳过。"""
    started = g.pop('request_started', None)
    elapsed_ms = (time.perf_counter() - started) * 1000 if started is not None else -1.0
    if request.method == 'GET' and request.path in POLLING_PATHS and response.status_code < 400:
        return response
    query = request.query_string.decode('utf-8', 'replace')
    log.log(
        logging.WARNING if response.status_code >= 400 else logging.INFO,
        '%s %s%s -> %d (%.1f ms)',
        request.method, request.path, ('?' + query) if query else '', response.status_code, elapsed_ms,
    )
    return response


@app.after_request
def disable_dynamic_response_cache(response):
    """Keep the local UI and API in sync while the app is being updated."""
    if request.path == '/' or request.path.startswith('/api/'):
        response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
        response.headers['Pragma'] = 'no-cache'
        response.headers['Expires'] = '0'
    return response

DATE_RE = re.compile(r'^\d{4}-\d{2}-\d{2}$')


def now_str():
    return datetime.now().strftime('%Y-%m-%d %H:%M:%S')


def get_db():
    """每请求独立连接。"""
    if 'db' not in g:
        g.db = sqlite3.connect(RECORDS_DB_PATH)
        g.db.row_factory = sqlite3.Row
    return g.db


def get_details_db():
    if 'details_db' not in g:
        g.details_db = sqlite3.connect(DETAILS_DB_PATH)
        g.details_db.row_factory = sqlite3.Row
    return g.details_db


@app.teardown_appcontext
def close_db(exc):
    db = g.pop('db', None)
    if db is not None:
        db.close()
    details_db = g.pop('details_db', None)
    if details_db is not None:
        details_db.close()


def init_db():
    """启动时建表，若已存在不重建。"""
    os.makedirs(DATA_DIR, exist_ok=True)
    log.info('初始化数据库 records=%s details=%s', RECORDS_DB_PATH, DETAILS_DB_PATH)
    conn = sqlite3.connect(RECORDS_DB_PATH)
    try:
        conn.execute('''
            CREATE TABLE IF NOT EXISTS records (
                id         TEXT PRIMARY KEY,
                date       TEXT UNIQUE NOT NULL,
                count      INTEGER NOT NULL DEFAULT 0,
                is_daily   INTEGER NOT NULL DEFAULT 0,
                created_at TEXT,
                updated_at TEXT
            )
        ''')
        details = sqlite3.connect(DETAILS_DB_PATH)
        details.execute('''CREATE TABLE IF NOT EXISTS submissions (id TEXT PRIMARY KEY, date TEXT NOT NULL, problem_key TEXT NOT NULL, created_at TEXT, UNIQUE(date, problem_key))''')
        details.execute('''CREATE TABLE IF NOT EXISTS daily_problems (date TEXT PRIMARY KEY, title TEXT NOT NULL, url TEXT NOT NULL, created_at TEXT, updated_at TEXT)''')
        details.commit()
        details.close()
        conn.execute('''CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)''')
        if os.path.isfile(LEGACY_DB_PATH) and os.path.abspath(LEGACY_DB_PATH) != os.path.abspath(RECORDS_DB_PATH):
            log.info('发现旧版数据库 %s，开始迁移', LEGACY_DB_PATH)
            conn.execute('ATTACH DATABASE ? AS legacy', (LEGACY_DB_PATH,))
            tables = {r[0] for r in conn.execute("SELECT name FROM legacy.sqlite_master WHERE type='table'")}
            log.info('旧库中的表: %s', ', '.join(sorted(tables)) or '(无)')
            if 'records' in tables:
                moved = conn.execute('INSERT OR IGNORE INTO records SELECT * FROM legacy.records').rowcount
                log.info('迁移 records: %d 条', moved)
            if 'settings' in tables:
                moved = conn.execute('INSERT OR IGNORE INTO settings SELECT * FROM legacy.settings').rowcount
                log.info('迁移 settings: %d 条', moved)
            conn.commit()
            conn.execute('DETACH DATABASE legacy')
            legacy_details = sqlite3.connect(LEGACY_DB_PATH)
            if 'submissions' in tables:
                details = sqlite3.connect(DETAILS_DB_PATH)
                details.execute('''CREATE TABLE IF NOT EXISTS submissions (id TEXT PRIMARY KEY, date TEXT NOT NULL, problem_key TEXT NOT NULL, created_at TEXT, UNIQUE(date, problem_key))''')
                details.execute('ATTACH DATABASE ? AS legacy', (LEGACY_DB_PATH,))
                moved = details.execute('INSERT OR IGNORE INTO submissions SELECT * FROM legacy.submissions').rowcount
                log.info('迁移 submissions: %d 条', moved)
                details.commit()
                details.execute('DETACH DATABASE legacy')
                details.close()
            legacy_details.close()
            log.info('旧库迁移完成，确认无误后可手动删除 %s', LEGACY_DB_PATH)
        conn.commit()
    finally:
        conn.close()


def validate_date(value):
    """校验并返回合法 YYYY-MM-DD；非法返回 None。"""
    if not isinstance(value, str) or not DATE_RE.match(value):
        return None
    try:
        date.fromisoformat(value)
    except ValueError:
        return None
    return value


def parse_count(value):
    """把 count 容错转成非负整数。规则：
    - None / 空白字符串(如 "") -> 0
    - 非负整数或可解析的非负整数字符串(如 "3") -> 对应 int
    - bool / 负数 / 无法解析的字符串 -> None"""
    if isinstance(value, bool):
        return None
    if value is None:
        return 0
    if isinstance(value, int):
        return value if value >= 0 else None
    if isinstance(value, str):
        if not value.strip():
            return 0
        try:
            n = int(value.strip())
        except ValueError:
            return None
        return n if n >= 0 else None
    return None


def parse_is_daily(value):
    """把 is_daily 转成 0/1，非法返回 None。"""
    if isinstance(value, bool):
        return 1 if value else 0
    if isinstance(value, int):
        return 1 if value else 0
    if isinstance(value, str):
        v = value.strip().lower()
        if v in ('1', 'true', 'yes'):
            return 1
        if v in ('0', 'false', 'no', ''):
            return 0
        return None
    return None


def upsert_record(date_str, count, is_daily):
    """upsert：created_at 只在插入时写，updated_at 每次都刷新。返回整行 dict。"""
    db = get_db()
    db.execute('''
        INSERT INTO records (id, date, count, is_daily, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(date) DO UPDATE SET
            count = excluded.count,
            is_daily = excluded.is_daily,
            updated_at = excluded.updated_at
    ''', (uuid.uuid4().hex, date_str, count, is_daily, now_str(), now_str()))
    db.commit()
    row = db.execute('SELECT * FROM records WHERE date = ?', (date_str,)).fetchone()
    return dict(row)


def problem_url_key(value):
    """Return a comparable host/path key for a daily URL or submission key."""
    if not isinstance(value, str):
        log.warning('题目链接不是字符串，按无法识别处理: %r', value)
        return ''
    raw = value.strip().split('|', 1)[0].strip()
    if not raw:
        log.warning('题目链接为空，按无法识别处理: %r', value)
        return ''
    if not re.match(r'^[a-z][a-z0-9+.-]*://', raw, re.IGNORECASE):
        raw = 'https://' + raw
    try:
        parsed = urlsplit(raw)
        host = (parsed.hostname or '').lower()
        if not host:
            log.warning('题目链接解析不出主机名，去重会失效: %r', value)
            return ''
        if host.startswith('www.'):
            host = host[4:]
        port = parsed.port
        if port and not ((parsed.scheme.lower() == 'http' and port == 80) or
                         (parsed.scheme.lower() == 'https' and port == 443)):
            host += ':' + str(port)
        return host + (parsed.path.rstrip('/') or '/')
    except ValueError as error:
        log.warning('题目链接解析失败，去重会失效: %r (%s)', value, error)
        return ''


def details_record_for_date(date_str):
    """Derive a day's count and daily-problem state from details.db."""
    details_db = get_details_db()
    rows = details_db.execute(
        'SELECT problem_key, created_at FROM submissions WHERE date = ?',
        (date_str,),
    ).fetchall()
    daily = details_db.execute(
        'SELECT url FROM daily_problems WHERE date = ?',
        (date_str,),
    ).fetchone()
    daily_key = problem_url_key(daily['url']) if daily else ''
    unique_keys = set()
    for row in rows:
        key = problem_url_key(row['problem_key']) or str(row['problem_key']).strip()
        if key:
            unique_keys.add(key)
    is_daily = int(bool(daily_key and any(
        problem_url_key(row['problem_key']) == daily_key for row in rows
    )))
    created_values = [row['created_at'] for row in rows if row['created_at']]
    return {
        'count': len(unique_keys),
        'is_daily': is_daily,
        'latest_submission_at': max(created_values) if created_values else None,
        'has_submissions': bool(rows),
    }


# “保留手动记录”是一个会持续成立的状态（直到该天再来一道新提交），而 /api/records 每 5 秒
# 就会走到这个分支。按日期记住上次已经记过的状态，只有状态真的变了才再打一行。
_manual_keep_logged = {}


def sync_record_from_details(date_str, force=False, include_empty=False):
    """Refresh an aggregate when newer accepted-submission details exist.

    A manually entered record is newer than the detail rows it was based on and
    is therefore left alone until another accepted submission arrives.

    这个函数会被 /api/records、/api/summary 的轮询每 5 秒调到一次，所以只在
    真的发生改变（或手动值与明细值不一致而手动值胜出）时才打日志，避免刷屏。
    """
    derived = details_record_for_date(date_str)
    db = get_db()
    current = db.execute(
        'SELECT * FROM records WHERE date = ?', (date_str,)
    ).fetchone()
    if not derived['has_submissions'] and not include_empty:
        return dict(current) if current else None
    if not force and current and current['updated_at'] and derived['latest_submission_at'] and \
            current['updated_at'] >= derived['latest_submission_at']:
        state = (int(current['count']), int(current['is_daily']), derived['count'], derived['is_daily'])
        if (state[0] != state[2] or state[1] != state[3]) and state != _manual_keep_logged.get(date_str):
            _manual_keep_logged[date_str] = state
            log.info(
                '保留手动记录 date=%s：手动 count=%d is_daily=%d 比明细算出的 count=%d is_daily=%d 新（updated_at=%s >= 最后提交=%s）',
                date_str, state[0], state[1], state[2], state[3],
                current['updated_at'], derived['latest_submission_at'],
            )
        return dict(current)
    _manual_keep_logged.pop(date_str, None)
    log.info(
        '按题目明细重算 date=%s：count %s -> %d，is_daily %s -> %d（%s）',
        date_str,
        int(current['count']) if current else '(无记录)', derived['count'],
        int(current['is_daily']) if current else '(无记录)', derived['is_daily'],
        '强制重算' if force else '明细比手动记录新',
    )
    return upsert_record(date_str, derived['count'], derived['is_daily'])


def sync_today_record_from_details(force=False, include_empty=False):
    return sync_record_from_details(
        date.today().isoformat(), force=force, include_empty=include_empty
    )


def row_to_dict(row):
    d = dict(row)
    d['is_daily'] = int(d['is_daily'])
    return d


def row_to_int_dict(row):
    d = dict(row)
    d['count'] = int(d['count'])
    d['is_daily'] = int(d['is_daily'])
    return d


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/api/records', methods=['GET'])
def list_records():
    sync_today_record_from_details()
    db = get_db()
    rows = db.execute('SELECT * FROM records ORDER BY date ASC').fetchall()
    return jsonify({'records': [row_to_int_dict(r) for r in rows]})


@app.route('/api/records', methods=['POST'])
def save_record():
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        log.warning('保存记录被拒：请求体不是 JSON 对象 (%r)', body)
        return jsonify({'error': '请求体必须为 JSON 对象'}), 400

    date_str = validate_date(body.get('date'))
    if date_str is None:
        log.warning('保存记录被拒：date 非法 (%r)', body.get('date'))
        return jsonify({'error': 'date 必须是合法 YYYY-MM-DD'}), 400

    count = parse_count(body.get('count', 0))
    if count is None:
        log.warning('保存记录被拒：date=%s count 非法 (%r)', date_str, body.get('count'))
        return jsonify({'error': 'count 必须是非负整数'}), 400

    is_daily = parse_is_daily(body.get('is_daily', 0))
    if is_daily is None:
        log.warning('保存记录被拒：date=%s is_daily 非法 (%r)', date_str, body.get('is_daily'))
        return jsonify({'error': 'is_daily 必须为 0 或 1'}), 400

    if count == 0 and is_daily == 0:
        # 删除规则：count=0 且 is_daily=0，表示当天无任何活动，等于没记录过。
        db = get_db()
        deleted = db.execute('DELETE FROM records WHERE date = ?', (date_str,)).rowcount
        db.commit()
        log.info('删除记录 date=%s（count=0 且未完成每日一题），实删 %d 行', date_str, deleted)
        return jsonify({'deleted': True})

    log.info('手动保存记录 date=%s count=%d is_daily=%d', date_str, count, is_daily)
    return jsonify({'record': upsert_record(date_str, count, is_daily)})


@app.route('/api/submissions', methods=['POST'])
def save_submission():
    """Record one accepted problem; the unique key makes retries idempotent."""
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        log.warning('记录通过题目被拒：请求体不是 JSON 对象 (%r)', body)
        return jsonify({'error': '请求体必须为 JSON 对象'}), 400
    date_str = validate_date(body.get('date'))
    problem_url = body.get('problem_url')
    problem_title = body.get('problem_title')
    if problem_url is not None or problem_title is not None:
        if (not isinstance(problem_url, str) or not problem_url.strip() or
                not isinstance(problem_title, str) or not problem_title.strip()):
            log.warning('记录通过题目被拒：题名或链接为空 (url=%r title=%r)', problem_url, problem_title)
            return jsonify({'error': '题目名称和题目链接不能为空'}), 400
        problem_url = problem_url.strip()[:1000]
        problem_title = problem_title.strip().replace('|', ' ')[:500]
        if not problem_url_key(problem_url):
            log.warning('记录通过题目被拒：链接无效 (%r)', problem_url)
            return jsonify({'error': '题目链接无效'}), 400
        problem_key = problem_url + '|' + problem_title
    else:
        problem_key = body.get('problem_key')
    if date_str is None or not isinstance(problem_key, str) or not problem_key.strip():
        log.warning('记录通过题目被拒：date=%r problem_key=%r', body.get('date'), problem_key)
        return jsonify({'error': 'date 或 problem_key 无效'}), 400
    problem_key = problem_key.strip()[:1500]

    db = get_details_db()
    now = now_str()
    normalized_key = problem_url_key(problem_key)
    if normalized_key:
        existing_rows = db.execute(
            'SELECT problem_key FROM submissions WHERE date = ?', (date_str,)
        ).fetchall()
        if any(problem_url_key(row['problem_key']) == normalized_key for row in existing_rows):
            db.commit()
            log.info('重复提交，忽略 date=%s 链接=%s（当天已有 %d 条明细）',
                     date_str, normalized_key, len(existing_rows))
            if date_str == date.today().isoformat():
                sync_today_record_from_details(force=True)
            row = get_db().execute('SELECT count, is_daily FROM records WHERE date = ?', (date_str,)).fetchone()
            return jsonify({
                'duplicate': True,
                'message': '今天已经通过了，重复提交无效',
                'record': row_to_int_dict(row) if row else None,
            })
    cursor = db.execute(
        'INSERT OR IGNORE INTO submissions (id, date, problem_key, created_at) VALUES (?, ?, ?, ?)',
        (uuid.uuid4().hex, date_str, problem_key, now),
    )
    if cursor.rowcount == 0:
        db.commit()
        log.info('重复提交（数据库唯一键冲突），忽略 date=%s key=%s', date_str, problem_key)
        if date_str == date.today().isoformat():
            sync_today_record_from_details(force=True)
        row = get_db().execute('SELECT count, is_daily FROM records WHERE date = ?', (date_str,)).fetchone()
        return jsonify({
            'duplicate': True,
            'message': '今天已经通过了，重复提交无效',
            'record': row_to_int_dict(row) if row else None,
        })

    db.commit()
    log.info('新增通过题目 date=%s 题名=%s 链接=%s', date_str, problem_key.split('|', 1)[-1], normalized_key or problem_key)
    if date_str == date.today().isoformat():
        record = sync_today_record_from_details(force=True)
    else:
        row = get_db().execute('SELECT count, is_daily FROM records WHERE date = ?', (date_str,)).fetchone()
        count = (int(row['count']) if row else 0) + 1
        is_daily = int(row['is_daily']) if row else 0
        log.info('补记往日题目 date=%s：count %s -> %d', date_str, int(row['count']) if row else '(无记录)', count)
        record = upsert_record(date_str, count, is_daily)
    return jsonify({'duplicate': False, 'problem_key': problem_key, 'record': record})


@app.route('/api/submissions', methods=['GET'])
def list_submissions():
    date_str = request.args.get('date')
    if date_str is not None and validate_date(date_str) is None:
        return jsonify({'error': 'date 必须是合法 YYYY-MM-DD'}), 400
    db = get_details_db()
    if date_str:
        rows = db.execute(
            'SELECT id, date, problem_key, created_at FROM submissions WHERE date = ? ORDER BY created_at ASC',
            (date_str,),
        ).fetchall()
    else:
        rows = db.execute(
            'SELECT id, date, problem_key, created_at FROM submissions ORDER BY date ASC, created_at ASC'
        ).fetchall()
    daily_keys = {r['date']: problem_url_key(r['url'])
                  for r in db.execute('SELECT date, url FROM daily_problems').fetchall()}
    items = []
    for row in rows:
        item = dict(row)
        daily_key = daily_keys.get(item['date'], '')
        item['is_daily'] = int(bool(daily_key and problem_url_key(item['problem_key']) == daily_key))
        items.append(item)
    return jsonify({'submissions': items})


@app.route('/api/submissions/<submission_id>', methods=['DELETE'])
def delete_submission(submission_id):
    if not isinstance(submission_id, str) or not submission_id.strip():
        log.warning('删除题目被拒：submission_id 无效 (%r)', submission_id)
        return jsonify({'error': 'submission_id 无效'}), 400
    details_db = get_details_db()
    row = details_db.execute(
        'SELECT id, date, problem_key FROM submissions WHERE id = ?', (submission_id,)
    ).fetchone()
    if row is None:
        log.warning('删除题目失败：id=%s 不存在', submission_id)
        return jsonify({'error': '题目不存在'}), 404
    details_db.execute('DELETE FROM submissions WHERE id = ?', (submission_id,))
    details_db.commit()
    log.info('删除通过题目 id=%s date=%s 题名=%s', submission_id, row['date'], row['problem_key'].split('|', 1)[-1])
    if row['date'] == date.today().isoformat():
        record = sync_today_record_from_details(force=True, include_empty=True)
    else:
        record = sync_record_from_details(row['date'], force=True, include_empty=True)
    return jsonify({'deleted': True, 'record': record})


@app.route('/api/daily-problems', methods=['POST'])
def save_daily_problem():
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify({'error': '请求体必须为 JSON 对象'}), 400
    date_str = validate_date(body.get('date'))
    title = body.get('title')
    url = body.get('url')
    if date_str is None or not isinstance(title, str) or not title.strip() or not isinstance(url, str) or not url.strip():
        log.warning('保存每日一题被拒：date=%r title=%r url=%r', body.get('date'), title, url)
        return jsonify({'error': 'date、title 或 url 无效'}), 400
    db = get_details_db()
    now = now_str()
    db.execute('''INSERT INTO daily_problems (date, title, url, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
                  ON CONFLICT(date) DO UPDATE SET title=excluded.title, url=excluded.url, updated_at=excluded.updated_at''',
               (date_str, title.strip()[:500], url.strip()[:1000], now, now))
    db.commit()
    row = db.execute('SELECT * FROM daily_problems WHERE date = ?', (date_str,)).fetchone()
    log.info('保存每日一题 date=%s 题名=%s 链接=%s', date_str, title.strip()[:500], url.strip()[:1000])
    if date_str == date.today().isoformat():
        sync_today_record_from_details(force=True)
    return jsonify({'problem': dict(row)})


@app.route('/api/daily-problems', methods=['GET'])
def list_daily_problems():
    date_str = request.args.get('date')
    if date_str is not None and validate_date(date_str) is None:
        return jsonify({'error': 'date 必须是合法 YYYY-MM-DD'}), 400
    db = get_details_db()
    if date_str:
        rows = db.execute('SELECT date, title, url, created_at, updated_at FROM daily_problems WHERE date = ?', (date_str,)).fetchall()
    else:
        rows = db.execute('SELECT date, title, url, created_at, updated_at FROM daily_problems ORDER BY date ASC').fetchall()
    return jsonify({'problems': [dict(r) for r in rows]})


@app.route('/api/summary', methods=['GET'])
def summary():
    sync_today_record_from_details()
    db = get_db()
    rows = db.execute('SELECT date, count, is_daily FROM records').fetchall()

    total_count = sum(int(r['count']) for r in rows)

    # 单日最大 count，并列取最早（按 date 升序遍历，仅严格大于时更新即可保留最早日期）
    best_day_count = 0
    best_day_date = None
    ordered = sorted(rows, key=lambda r: r['date'])
    for r in ordered:
        c = int(r['count'])
        if c > best_day_count:
            best_day_count = c
            best_day_date = r['date']

    # 严格连登：以服务器本地日期为“今天”，从今天起逐日回溯
    today = date.today()
    today_str = today.strftime('%Y-%m-%d')

    def consecutive_days(present):
        """从今天起逐日回溯连续出现在 present 中的天数；今天不在则视为 0。"""
        if today_str not in present:
            return 0
        n = 0
        cursor = today
        while True:
            ds = cursor.strftime('%Y-%m-%d')
            if ds in present:
                n += 1
                cursor -= timedelta(days=1)
            else:
                break
        return n

    daily_set = {r['date'] for r in rows if int(r['is_daily']) == 1}          # 勾选每日一题的天
    problem_set = {r['date'] for r in rows if int(r['count']) > 0}            # 有普通刷题（count>0）的天

    return jsonify({
        'total_count': total_count,
        'best_day_count': best_day_count,
        'best_day_date': best_day_date,
        'streak': consecutive_days(daily_set),           # 连续打卡每日一题（天）
        'problem_streak': consecutive_days(problem_set), # 连续刷题（count>0，天）
    })


@app.route('/api/export', methods=['GET'])
def export_records():
    sync_today_record_from_details()
    db = get_db()
    rows = db.execute('SELECT * FROM records ORDER BY date ASC').fetchall()
    submissions = get_details_db().execute(
        'SELECT date, problem_key, created_at FROM submissions ORDER BY date ASC, created_at ASC'
    ).fetchall()
    daily_problems = get_details_db().execute(
        'SELECT date, title, url, created_at, updated_at FROM daily_problems ORDER BY date ASC'
    ).fetchall()
    log.info('导出备份：records=%d submissions=%d daily_problems=%d',
             len(rows), len(submissions), len(daily_problems))
    return jsonify({
        'exported_at': now_str(),
        'records': [row_to_int_dict(r) for r in rows],
        'submissions': [dict(r) for r in submissions],
        'daily_problems': [dict(r) for r in daily_problems],
    })


@app.route('/api/import', methods=['POST'])
def import_records():
    body = request.get_json(silent=True)
    if isinstance(body, dict) and 'records' in body:
        records = body['records']
        submissions = body.get('submissions', [])
        daily_problems = body.get('daily_problems', [])
    elif isinstance(body, list):
        records = body
        submissions = []
        daily_problems = []
    else:
        log.warning('导入被拒：请求体既不是数组也不含 records 字段 (%r)', type(body).__name__)
        return jsonify({'error': '请求体必须为数组或 {"records": [...]}'}), 400
    if not isinstance(records, list):
        log.warning('导入被拒：records 不是数组 (%r)', type(records).__name__)
        return jsonify({'error': 'records 必须为数组'}), 400
    log.info('开始导入：records=%d submissions=%d daily_problems=%d',
             len(records),
             len(submissions) if isinstance(submissions, list) else 0,
             len(daily_problems) if isinstance(daily_problems, list) else 0)

    db = get_db()
    details_db = get_details_db()
    try:
        now = now_str()
        n = 0
        for item in records:
            if not isinstance(item, dict):
                continue
            date_str = validate_date(item.get('date'))
            if date_str is None:
                continue
            count = parse_count(item.get('count', 0))
            if count is None:
                count = 0
            is_daily = parse_is_daily(item.get('is_daily', 0))
            if is_daily is None:
                is_daily = 0
            # 导入不做删除规则：count=0 + is_daily=0 也照常写入/覆盖，保证还原完整性。
            db.execute('''
                INSERT INTO records (id, date, count, is_daily, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(date) DO UPDATE SET
                    count = excluded.count,
                    is_daily = excluded.is_daily,
                    updated_at = excluded.updated_at
            ''', (uuid.uuid4().hex, date_str, count, is_daily, now, now))
            n += 1
        for item in submissions if isinstance(submissions, list) else []:
            if not isinstance(item, dict):
                continue
            date_str = validate_date(item.get('date'))
            problem_key = item.get('problem_key')
            if date_str is None or not isinstance(problem_key, str) or not problem_key.strip():
                continue
            details_db.execute(
                'INSERT OR IGNORE INTO submissions (id, date, problem_key, created_at) VALUES (?, ?, ?, ?)',
                (uuid.uuid4().hex, date_str, problem_key.strip()[:1500], item.get('created_at') or now),
            )
        for item in daily_problems if isinstance(daily_problems, list) else []:
            if not isinstance(item, dict):
                continue
            date_str = validate_date(item.get('date'))
            title = item.get('title')
            url = item.get('url')
            if date_str is None or not isinstance(title, str) or not title.strip() or not isinstance(url, str) or not url.strip():
                continue
            details_db.execute('''INSERT INTO daily_problems (date, title, url, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
                                  ON CONFLICT(date) DO UPDATE SET title=excluded.title, url=excluded.url, updated_at=excluded.updated_at''',
                               (date_str, title.strip()[:500], url.strip()[:1000], item.get('created_at') or now, item.get('updated_at') or now))
        db.commit()
        details_db.commit()
        sync_today_record_from_details()
    except Exception as e:
        db.rollback()
        details_db.rollback()
        log.exception('导入失败，已回滚: %s', e)
        return jsonify({'error': '导入失败: %s' % e}), 500

    log.info('导入完成：写入 %d 条记录', n)
    return jsonify({'imported': n})


def load_setting(key):
    """读 settings 表中某 key 的 JSON value；无记录或非法时返回 {}。"""
    db = get_db()
    row = db.execute('SELECT value FROM settings WHERE key = ?', (key,)).fetchone()
    if row is None:
        return {}
    try:
        v = json.loads(row['value'])
    except (ValueError, TypeError):
        return {}
    return v if isinstance(v, dict) else {}


@app.route('/api/settings', methods=['GET'])
def get_settings():
    return jsonify({
        'nowcoder': load_setting('nowcoder'),
        'appearance': load_setting('appearance'),
    })
# 注意：/api/settings 的返回体里含明文密码，这里刻意不打日志，避免密码进入日志窗口与导出的日志文件。


def _remove_bg_file(rel_url):
    """按 /static/backgrounds/xxx 相对地址删除对应背景文件（不存在则忽略）。"""
    if rel_url and rel_url.startswith(BG_URL_PREFIX):
        try:
            p = os.path.join(BG_DIR, os.path.basename(rel_url))
            if os.path.isfile(p):
                os.remove(p)
                log.info('删除背景文件 %s', p)
        except OSError as error:
            log.warning('删除背景文件失败 %s: %s', rel_url, error)


@app.route('/api/background', methods=['POST'])
def upload_background():
    f = request.files.get('file')
    if f is None or not f.filename:
        log.warning('上传背景被拒：没有文件字段或文件名为空')
        return jsonify({'error': '未选择图片文件'}), 400
    ext = os.path.splitext(f.filename)[1].lower()
    if ext not in ALLOWED_IMG_EXT:
        log.warning('上传背景被拒：扩展名 %r 不在允许列表 %s', ext, ALLOWED_IMG_EXT)
        return jsonify({'error': '仅支持图片格式：' + ', '.join(ALLOWED_IMG_EXT)}), 400

    os.makedirs(BG_DIR, exist_ok=True)
    filename = 'bg_' + uuid.uuid4().hex[:12] + ext
    path = os.path.join(BG_DIR, filename)
    try:
        f.save(path)
    except Exception as e:
        log.exception('背景图片保存失败: %s', e)
        return jsonify({'error': '保存失败: %s' % e}), 500
    size = os.path.getsize(path)
    if size > MAX_BG_SIZE:
        log.warning('上传背景被拒：%s 大小 %.1fMB 超过 20MB 上限', f.filename, size / 1024.0 / 1024.0)
        _remove_bg_file(BG_URL_PREFIX + filename)
        return jsonify({'error': '图片不能超过 20MB'}), 400

    rel = BG_URL_PREFIX + filename
    prev = (load_setting('appearance') or {}).get('background', '')
    log.info('保存背景图片 原名=%s 扩展名=%s 大小=%.1fKB 新地址=%s 原地址=%s',
             f.filename, ext, size / 1024.0, rel, prev or '(无)')
    _remove_bg_file(prev)  # 只保留最新一张，避免文件堆积
    db = get_db()
    db.execute('''
        INSERT INTO settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
    ''', ('appearance', json.dumps({'background': rel}, ensure_ascii=False)))
    db.commit()
    return jsonify({'ok': True, 'background': rel})


@app.route('/api/background', methods=['DELETE'])
def clear_background():
    prev = (load_setting('appearance') or {}).get('background', '')
    _remove_bg_file(prev)
    db = get_db()
    db.execute('''
        INSERT INTO settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
    ''', ('appearance', json.dumps({'background': ''}, ensure_ascii=False)))
    db.commit()
    return jsonify({'ok': True, 'background': ''})


@app.route('/api/settings/nowcoder', methods=['POST'])
def save_nowcoder_settings():
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        log.warning('保存牛客账号被拒：请求体不是 JSON 对象 (%r)', body)
        return jsonify({'error': '请求体必须为 JSON 对象'}), 400

    def clean_str(v):
        if isinstance(v, str):
            return v.strip()
        if isinstance(v, (int, float)):
            return str(v)
        return ''

    cur = load_setting('nowcoder')
    cur['account'] = clean_str(body.get('account'))
    cur['password'] = clean_str(body.get('password'))
    # 只记账号与密码是否为空，绝不记密码本身——它会进日志窗口和导出的 runtime.log
    log.info('保存牛客账号 账号=%s 密码=%s',
             cur['account'] or '(空)', '已设置' if cur['password'] else '(空)')

    db = get_db()
    db.execute('''
        INSERT INTO settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
    ''', ('nowcoder', json.dumps(cur, ensure_ascii=False)))
    db.commit()
    return jsonify({'ok': True, 'nowcoder': cur})


@app.errorhandler(Exception)
def handle_unexpected_error(error):
    """兜底：任何未捕获异常都带完整堆栈记下来，不然日志里只剩一个 500。"""
    if isinstance(error, HTTPException):
        return error
    log.exception('未处理的异常: %s', error)
    return jsonify({'error': '服务器内部错误: %s' % error}), 500


if __name__ == '__main__':
    init_db()
    port = int(os.environ.get('PORT', 5000))
    log.info('CodeAgenda 后端启动：端口=%d 工作目录=%s Python=%s', port, BASE_DIR, sys.version.split()[0])
    log.info('牛客刷题记录已启动，请在浏览器打开 http://127.0.0.1:%d', port)
    app.run(host='127.0.0.1', port=port, debug=False)
