# -*- coding: utf-8 -*-
"""牛客刷题记录本地网页工具 —— Flask 后端 + SQLite。"""
import json
import os
import re
import sqlite3
import uuid
from datetime import datetime, date, timedelta
from urllib.parse import urlsplit

from flask import Flask, jsonify, request, render_template, g

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, 'data')
RECORDS_DB_PATH = os.path.join(DATA_DIR, 'records.db')
DETAILS_DB_PATH = os.path.join(DATA_DIR, 'details.db')
LEGACY_DB_PATH = os.path.join(BASE_DIR, 'records.db')
BG_DIR = os.path.join(BASE_DIR, 'static', 'backgrounds')
BG_URL_PREFIX = '/static/backgrounds/'
ALLOWED_IMG_EXT = ('.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.avif')
MAX_BG_SIZE = 20 * 1024 * 1024  # 20MB

app = Flask(__name__)


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
            conn.execute('ATTACH DATABASE ? AS legacy', (LEGACY_DB_PATH,))
            tables = {r[0] for r in conn.execute("SELECT name FROM legacy.sqlite_master WHERE type='table'")}
            if 'records' in tables:
                conn.execute('INSERT OR IGNORE INTO records SELECT * FROM legacy.records')
            if 'settings' in tables:
                conn.execute('INSERT OR IGNORE INTO settings SELECT * FROM legacy.settings')
            conn.commit()
            conn.execute('DETACH DATABASE legacy')
            legacy_details = sqlite3.connect(LEGACY_DB_PATH)
            if 'submissions' in tables:
                details = sqlite3.connect(DETAILS_DB_PATH)
                details.execute('''CREATE TABLE IF NOT EXISTS submissions (id TEXT PRIMARY KEY, date TEXT NOT NULL, problem_key TEXT NOT NULL, created_at TEXT, UNIQUE(date, problem_key))''')
                details.execute('ATTACH DATABASE ? AS legacy', (LEGACY_DB_PATH,))
                details.execute('INSERT OR IGNORE INTO submissions SELECT * FROM legacy.submissions')
                details.commit()
                details.execute('DETACH DATABASE legacy')
                details.close()
            legacy_details.close()
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
        return ''
    raw = value.strip().split('|', 1)[0].strip()
    if not raw:
        return ''
    if not re.match(r'^[a-z][a-z0-9+.-]*://', raw, re.IGNORECASE):
        raw = 'https://' + raw
    try:
        parsed = urlsplit(raw)
        host = (parsed.hostname or '').lower()
        if not host:
            return ''
        if host.startswith('www.'):
            host = host[4:]
        port = parsed.port
        if port and not ((parsed.scheme.lower() == 'http' and port == 80) or
                         (parsed.scheme.lower() == 'https' and port == 443)):
            host += ':' + str(port)
        return host + (parsed.path.rstrip('/') or '/')
    except ValueError:
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


def sync_record_from_details(date_str, force=False, include_empty=False):
    """Refresh an aggregate when newer accepted-submission details exist.

    A manually entered record is newer than the detail rows it was based on and
    is therefore left alone until another accepted submission arrives.
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
        return dict(current)
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
        return jsonify({'error': '请求体必须为 JSON 对象'}), 400

    date_str = validate_date(body.get('date'))
    if date_str is None:
        return jsonify({'error': 'date 必须是合法 YYYY-MM-DD'}), 400

    count = parse_count(body.get('count', 0))
    if count is None:
        return jsonify({'error': 'count 必须是非负整数'}), 400

    is_daily = parse_is_daily(body.get('is_daily', 0))
    if is_daily is None:
        return jsonify({'error': 'is_daily 必须为 0 或 1'}), 400

    if count == 0 and is_daily == 0:
        # 删除规则：count=0 且 is_daily=0，表示当天无任何活动，等于没记录过。
        db = get_db()
        db.execute('DELETE FROM records WHERE date = ?', (date_str,))
        db.commit()
        return jsonify({'deleted': True})

    return jsonify({'record': upsert_record(date_str, count, is_daily)})


@app.route('/api/submissions', methods=['POST'])
def save_submission():
    """Record one accepted problem; the unique key makes retries idempotent."""
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify({'error': '请求体必须为 JSON 对象'}), 400
    date_str = validate_date(body.get('date'))
    problem_url = body.get('problem_url')
    problem_title = body.get('problem_title')
    if problem_url is not None or problem_title is not None:
        if (not isinstance(problem_url, str) or not problem_url.strip() or
                not isinstance(problem_title, str) or not problem_title.strip()):
            return jsonify({'error': '题目名称和题目链接不能为空'}), 400
        problem_url = problem_url.strip()[:1000]
        problem_title = problem_title.strip().replace('|', ' ')[:500]
        if not problem_url_key(problem_url):
            return jsonify({'error': '题目链接无效'}), 400
        problem_key = problem_url + '|' + problem_title
    else:
        problem_key = body.get('problem_key')
    if date_str is None or not isinstance(problem_key, str) or not problem_key.strip():
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
        if date_str == date.today().isoformat():
            sync_today_record_from_details(force=True)
        row = get_db().execute('SELECT count, is_daily FROM records WHERE date = ?', (date_str,)).fetchone()
        return jsonify({
            'duplicate': True,
            'message': '今天已经通过了，重复提交无效',
            'record': row_to_int_dict(row) if row else None,
        })

    db.commit()
    if date_str == date.today().isoformat():
        record = sync_today_record_from_details(force=True)
    else:
        row = get_db().execute('SELECT count, is_daily FROM records WHERE date = ?', (date_str,)).fetchone()
        count = (int(row['count']) if row else 0) + 1
        is_daily = int(row['is_daily']) if row else 0
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
    return jsonify({'submissions': [dict(r) for r in rows]})


@app.route('/api/submissions/<submission_id>', methods=['DELETE'])
def delete_submission(submission_id):
    if not isinstance(submission_id, str) or not submission_id.strip():
        return jsonify({'error': 'submission_id 无效'}), 400
    details_db = get_details_db()
    row = details_db.execute(
        'SELECT id, date FROM submissions WHERE id = ?', (submission_id,)
    ).fetchone()
    if row is None:
        return jsonify({'error': '题目不存在'}), 404
    details_db.execute('DELETE FROM submissions WHERE id = ?', (submission_id,))
    details_db.commit()
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
        return jsonify({'error': 'date、title 或 url 无效'}), 400
    db = get_details_db()
    now = now_str()
    db.execute('''INSERT INTO daily_problems (date, title, url, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
                  ON CONFLICT(date) DO UPDATE SET title=excluded.title, url=excluded.url, updated_at=excluded.updated_at''',
               (date_str, title.strip()[:500], url.strip()[:1000], now, now))
    db.commit()
    row = db.execute('SELECT * FROM daily_problems WHERE date = ?', (date_str,)).fetchone()
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
        return jsonify({'error': '请求体必须为数组或 {"records": [...]}'}), 400
    if not isinstance(records, list):
        return jsonify({'error': 'records 必须为数组'}), 400

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
        return jsonify({'error': '导入失败: %s' % e}), 500

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


def _remove_bg_file(rel_url):
    """按 /static/backgrounds/xxx 相对地址删除对应背景文件（不存在则忽略）。"""
    if rel_url and rel_url.startswith(BG_URL_PREFIX):
        try:
            p = os.path.join(BG_DIR, os.path.basename(rel_url))
            if os.path.isfile(p):
                os.remove(p)
        except OSError:
            pass


@app.route('/api/background', methods=['POST'])
def upload_background():
    f = request.files.get('file')
    if f is None or not f.filename:
        return jsonify({'error': '未选择图片文件'}), 400
    ext = os.path.splitext(f.filename)[1].lower()
    if ext not in ALLOWED_IMG_EXT:
        return jsonify({'error': '仅支持图片格式：' + ', '.join(ALLOWED_IMG_EXT)}), 400

    os.makedirs(BG_DIR, exist_ok=True)
    filename = 'bg_' + uuid.uuid4().hex[:12] + ext
    path = os.path.join(BG_DIR, filename)
    try:
        f.save(path)
    except Exception as e:
        return jsonify({'error': '保存失败: %s' % e}), 500
    if os.path.getsize(path) > MAX_BG_SIZE:
        _remove_bg_file(BG_URL_PREFIX + filename)
        return jsonify({'error': '图片不能超过 20MB'}), 400

    rel = BG_URL_PREFIX + filename
    prev = (load_setting('appearance') or {}).get('background', '')
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

    db = get_db()
    db.execute('''
        INSERT INTO settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
    ''', ('nowcoder', json.dumps(cur, ensure_ascii=False)))
    db.commit()
    return jsonify({'ok': True, 'nowcoder': cur})


if __name__ == '__main__':
    init_db()
    port = int(os.environ.get('PORT', 5000))
    print('牛客刷题记录已启动，请在浏览器打开 http://127.0.0.1:%d' % port)
    app.run(host='127.0.0.1', port=port, debug=False)
