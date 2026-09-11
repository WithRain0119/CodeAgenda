# -*- coding: utf-8 -*-
"""CodeAgenda tray launcher and Qt log window."""
from __future__ import annotations
import ctypes, os, subprocess, sys, threading, webbrowser
from datetime import datetime
from pathlib import Path
from PyQt6.QtCore import QEasingCurve, QPropertyAnimation, QTimer, Qt
from PyQt6.QtGui import QColor, QCursor, QFont, QGuiApplication, QIcon, QPainter, QPixmap
from PyQt6.QtSvg import QSvgRenderer
from PyQt6.QtWidgets import QApplication, QFrame, QGraphicsDropShadowEffect, QHBoxLayout, QLabel, QMainWindow, QMenu, QPlainTextEdit, QPushButton, QSystemTrayIcon, QVBoxLayout, QWidget

try:
    import msvcrt
except ImportError:
    msvcrt = None

BASE_DIR = Path(__file__).resolve().parent
LOCK_PATH = BASE_DIR / ".codeagenda.lock"
LOG_DIR = BASE_DIR / "log"                       # 仅“导出日志”时创建，整个目录不入库
WEB_URL = os.environ.get("CODEAGENDA_URL", "http://127.0.0.1:5000")
ICON_PATH = BASE_DIR / "static" / "favicon.svg"
# Windows 托盘与任务栏会按系统尺寸（16/32/48…）索要 HICON，这里预先把 SVG 渲染成各档位位图，
# 避免 QIcon(路径) 惰性加载时取不到对应尺寸而回退成 pythonw.exe 的默认图标。
ICON_SIZES = (16, 20, 24, 32, 40, 48, 64, 128, 256)


# Windows 任务栏按「应用」归组按钮，进程没声明 AppUserModelID 时会挂到 pythonw.exe 名下，
# 于是任务栏按钮显示 pythonw.exe 的 Python 图标，而不是窗口自己设的 WM_SETICON 图标。
APP_USER_MODEL_ID = "CodeAgenda.Tray"


def set_app_user_model_id():
    try:
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(APP_USER_MODEL_ID)
    except (AttributeError, OSError):
        pass  # 非 Windows 或调用失败：不影响托盘与网页功能


def load_icon():
    icon = QIcon()
    renderer = QSvgRenderer(str(ICON_PATH))
    if not renderer.isValid():
        return icon
    for size in ICON_SIZES:
        pixmap = QPixmap(size, size)
        pixmap.fill(Qt.GlobalColor.transparent)
        painter = QPainter(pixmap)
        renderer.render(painter)
        painter.end()
        icon.addPixmap(pixmap)
    return icon


class SingleInstance:
    def __init__(self, path): self.path, self.handle = path, None
    def acquire(self):
        if msvcrt is None: return True
        self.handle = open(self.path, "a+")
        try:
            self.handle.seek(0)
            if not self.handle.read(1): self.handle.write("0"); self.handle.flush()
        except OSError:
            self.handle.close(); self.handle = None; return False
        self.handle.seek(0)
        try: msvcrt.locking(self.handle.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            self.handle.close(); self.handle = None; return False
        self.handle.seek(0); self.handle.truncate(); self.handle.write(str(os.getpid())); self.handle.flush(); return True
    def release(self):
        if self.handle is not None:
            try: self.handle.seek(0); msvcrt.locking(self.handle.fileno(), msvcrt.LK_UNLCK, 1)
            finally: self.handle.close(); self.handle = None


class LogWindow(QMainWindow):
    def __init__(self, icon, on_export):
        super().__init__(); self.setWindowTitle("CodeAgenda 日志"); self.setWindowIcon(icon); self.resize(760, 480); self.setMinimumSize(520, 320)
        self.setWindowFlags(Qt.WindowType.Window | Qt.WindowType.WindowTitleHint | Qt.WindowType.WindowCloseButtonHint | Qt.WindowType.WindowMinimizeButtonHint)
        # 导出按钮：macOS 风格的浅蓝 tinted 按钮，无边框、圆角、悬停加深
        button_style = ('QPushButton{background:rgba(10,132,255,0.12);color:#0a84ff;border:none;border-radius:9px;padding:7px 16px;'
                        'font-size:12px;font-weight:600;font-family:"Segoe UI Variable Display","Segoe UI","Microsoft YaHei UI";}'
                        'QPushButton:hover{background:rgba(10,132,255,0.20);}'
                        'QPushButton:pressed{background:rgba(10,132,255,0.30);}')
        self.setStyleSheet("QMainWindow{background:#f5f5f7;} QLabel{color:#1d1d1f;} QPlainTextEdit{background:#fff;color:#1d1d1f;border:1px solid #e5e5e7;border-radius:12px;padding:12px;selection-background-color:#cfe3ff;} QScrollBar:vertical{width:10px;background:transparent;margin:4px;} QScrollBar::handle:vertical{background:#c7c7cc;border-radius:5px;min-height:30px;}" + button_style)
        title = QLabel("运行日志"); title.setFont(QFont("Segoe UI", 18, QFont.Weight.Bold))
        self.export_button = QPushButton("导出日志"); self.export_button.setCursor(Qt.CursorShape.PointingHandCursor); self.export_button.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        self.export_button.clicked.connect(lambda checked=False: on_export())
        head = QHBoxLayout(); head.setContentsMargins(0, 0, 0, 0); head.addWidget(title); head.addStretch(1); head.addWidget(self.export_button)
        self.text = QPlainTextEdit(); self.text.setReadOnly(True); self.text.setLineWrapMode(QPlainTextEdit.LineWrapMode.NoWrap)
        layout = QVBoxLayout(); layout.setContentsMargins(24, 22, 24, 24); layout.setSpacing(14); layout.addLayout(head); layout.addWidget(self.text)
        body = QWidget(); body.setLayout(layout); self.setCentralWidget(body)
    def closeEvent(self, event): event.ignore(); self.hide()


TOAST_MS = 3000                      # 提示卡停留时长（毫秒），之后自动淡出
TOAST_FONT = '"Segoe UI Variable Display","Segoe UI","Microsoft YaHei UI"'


class Toast(QWidget):
    """Apple 风格提示卡：无边框圆角、柔和投影、淡入淡出，到时自动消失，不抢焦点。"""

    def __init__(self, title, message, glyph="✓", accent="#34c759"):
        super().__init__(None)
        self.setWindowFlags(Qt.WindowType.Tool | Qt.WindowType.FramelessWindowHint |
                            Qt.WindowType.WindowStaysOnTopHint | Qt.WindowType.WindowDoesNotAcceptFocus)
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.setAttribute(Qt.WidgetAttribute.WA_ShowWithoutActivating)
        # 340px 是下限而非死宽：短文案（如启动提示）保持原样，长文案（如导出路径）自动撑宽，
        # 免得为了放下一行字被裁掉或被迫折行。
        self.setMinimumWidth(340)

        card = QFrame()
        card.setObjectName("toastCard")
        card.setStyleSheet(
            "#toastCard{background:rgba(250,250,252,238);border:1px solid rgba(0,0,0,20);border-radius:18px;}"
            "QLabel{background:transparent;}"
        )
        shadow = QGraphicsDropShadowEffect(self)
        shadow.setBlurRadius(38); shadow.setOffset(0, 8); shadow.setColor(QColor(0, 0, 0, 80))
        card.setGraphicsEffect(shadow)

        badge = QLabel(glyph)
        badge.setFixedSize(30, 30)
        badge.setAlignment(Qt.AlignmentFlag.AlignCenter)
        badge.setStyleSheet("background:%s;color:#fff;border-radius:15px;font-size:16px;font-weight:700;" % accent)

        head = QLabel(title)
        head.setStyleSheet('color:#1d1d1f;font-size:13px;font-weight:600;font-family:%s;' % TOAST_FONT)
        body = QLabel(message)
        body.setStyleSheet('color:#6e6e73;font-size:12px;font-family:%s;' % TOAST_FONT)

        column = QVBoxLayout(); column.setContentsMargins(0, 0, 0, 0); column.setSpacing(3)
        column.addWidget(head); column.addWidget(body)

        row = QHBoxLayout(); row.setContentsMargins(0, 0, 0, 0); row.setSpacing(12)
        row.addWidget(badge, 0, Qt.AlignmentFlag.AlignTop); row.addLayout(column, 1)

        # 仅在“不自动关闭”的提示卡上出现的确定按钮，居中放在卡片底部；
        # 自动消失的提示卡不需要它，整块隐藏后不占任何高度
        self.confirm_button = QPushButton("确定")
        self.confirm_button.setCursor(Qt.CursorShape.PointingHandCursor)
        self.confirm_button.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        self.confirm_button.setStyleSheet(
            'QPushButton{background:#0a84ff;color:#fff;border:none;border-radius:8px;padding:6px 26px;'
            'font-size:12px;font-weight:600;font-family:%s;}'
            'QPushButton:hover{background:#0077ed;}'
            'QPushButton:pressed{background:#0068d1;}' % TOAST_FONT
        )
        self.confirm_button.clicked.connect(self.dismiss)
        self.footer = QWidget()
        footer_row = QHBoxLayout(self.footer); footer_row.setContentsMargins(0, 14, 0, 0); footer_row.setSpacing(0)
        footer_row.addStretch(1); footer_row.addWidget(self.confirm_button); footer_row.addStretch(1)
        self.footer.hide()

        card_body = QVBoxLayout(card); card_body.setContentsMargins(16, 14, 18, 14); card_body.setSpacing(0)
        card_body.addLayout(row); card_body.addWidget(self.footer)

        # 外层留白，供投影绘制；窗口四周会多出 16px 透明边距
        outer = QVBoxLayout(self); outer.setContentsMargins(16, 16, 16, 16); outer.addWidget(card)

        self.fade_in = QPropertyAnimation(self, b"windowOpacity", self)
        self.fade_in.setDuration(220); self.fade_in.setStartValue(0.0); self.fade_in.setEndValue(1.0)
        self.fade_in.setEasingCurve(QEasingCurve.Type.OutCubic)
        self.fade_out = QPropertyAnimation(self, b"windowOpacity", self)
        self.fade_out.setDuration(320); self.fade_out.setEndValue(0.0)
        self.fade_out.setEasingCurve(QEasingCurve.Type.InCubic)
        self.fade_out.finished.connect(self.close)

    def popup(self, duration=TOAST_MS, anchor=None):
        """弹出提示卡，duration 毫秒后自动淡出关闭。

        duration 传 None 表示常驻：不启动自动关闭，改由卡片底部的“确定”按钮手动关掉。
        anchor 传一个窗口就居中显示在它上面（如“导出日志”对着运行日志窗口弹）；
        不传则贴屏幕右下角（任务栏上方），用于启动提示这类没有关联窗口的场景。"""
        if duration is None:
            self.footer.show()
        self.adjustSize()
        if anchor is not None:
            center = anchor.frameGeometry().center()   # 含边框，对着用户实际看到的窗口居中
            self.move(center.x() - self.width() // 2, center.y() - self.height() // 2)
        else:
            area = QGuiApplication.primaryScreen().availableGeometry()
            self.move(area.right() + 1 - self.width(), area.bottom() + 1 - self.height())
        self.setWindowOpacity(0.0); self.show(); self.fade_in.start()
        if duration is not None:
            QTimer.singleShot(duration, self.dismiss)

    def dismiss(self):
        if not self.isVisible(): return
        self.fade_in.stop()
        self.fade_out.setStartValue(self.windowOpacity()); self.fade_out.start()


class TrayApp:
    def __init__(self):
        self.instance = SingleInstance(LOCK_PATH); self.process = None; self.log_lines = []; self.log_lock = threading.Lock()
        self.backend_exit_code = None; self.stopping = False
        set_app_user_model_id()  # 必须在创建任何窗口之前声明，任务栏才会用本程序的图标
        self.qt = QApplication(sys.argv); self.qt.setQuitOnLastWindowClosed(False)
        self.icon = load_icon()
        self.qt.setWindowIcon(self.icon)  # 兜底：未单独设图标的窗口也显示日历图标，而不是 pythonw.exe 的默认图标
        self.tray = QSystemTrayIcon(self.icon); self.tray.setToolTip("CodeAgenda")
        self.log_window = LogWindow(self.icon, self.export_logs); self.timer = QTimer(); self.timer.timeout.connect(self.refresh_log); self.timer.start(250)
        self.toast = None
    def show_toast(self, title, message, glyph="✓", accent="#34c759", duration=TOAST_MS, anchor=None):
        self.toast = Toast(title, message, glyph, accent); self.toast.popup(duration, anchor); return self.toast
    def export_logs(self):
        """把本次启动以来的运行日志写到项目根目录 log/runtime.log。

        log/ 平时不存在，只有点“导出日志”时才建；路径或权限出错就退回系统托盘气泡提示。"""
        with self.log_lock: content = "\n".join(self.log_lines)
        try:
            LOG_DIR.mkdir(exist_ok=True)
            (LOG_DIR / "runtime.log").write_text(content + "\n", encoding="utf-8")
        except OSError as error:
            self.tray_log("导出日志失败：%s" % error)
            self.tray.showMessage("CodeAgenda", "日志导出失败：%s" % error, QSystemTrayIcon.MessageIcon.Critical, 5000)
            return
        self.tray_log("已导出日志到 %s（%d 行）" % (LOG_DIR / "runtime.log", len(self.log_lines)))
        # 常驻提示卡：不像启动提示那样自动消失，由用户点底部的「确定」关闭；
        # 居中弹在运行日志窗口上，而不是屏幕右下角（点导出的人正看着这个窗口）。
        # 路径写成 log/runtime.log 单行即可同时交代目录与文件名，卡片会自动撑宽放下它。
        self.show_toast("日志已导出", "已保存到项目 log/runtime.log",
                        "✓", "#34c759", duration=None, anchor=self.log_window)
    def append_log(self, line):
        line = line.rstrip("\r\n")
        if line:
            with self.log_lock: self.log_lines.append(line)
    def tray_log(self, message):
        """托盘自己的日志：加时间戳与 [托盘] 前缀，好和后端输出的行区分开。"""
        self.append_log("%s [托盘] %s" % (datetime.now().strftime('%H:%M:%S'), message))
    def read_output(self, stream):
        for line in iter(stream.readline, ""): self.append_log(line)
        stream.close()
    def start_backend(self):
        command = [sys.executable, "-u", str(BASE_DIR / "app.py")]; self.tray_log("启动后端: " + " ".join(command))
        env = os.environ.copy(); env["PYTHONIOENCODING"] = "utf-8"
        self.process = subprocess.Popen(command, cwd=BASE_DIR, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace", env=env, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        self.tray_log("后端进程已拉起，PID=%s" % self.process.pid)
        threading.Thread(target=self.read_output, args=(self.process.stdout,), daemon=True).start()
    def refresh_log(self):
        self.check_backend_alive()
        with self.log_lock: content = "\n".join(self.log_lines)
        if self.log_window.text.toPlainText() != content:
            self.log_window.text.setPlainText(content); bar = self.log_window.text.verticalScrollBar(); bar.setValue(bar.maximum())
    def check_backend_alive(self):
        """后端进程若已退出，记一次返回码——否则后端悄悄挂掉时日志里什么都看不到。"""
        if self.process is None or self.backend_exit_code is not None or self.stopping:
            return
        code = self.process.poll()
        if code is not None:
            self.backend_exit_code = code
            self.tray_log("后端进程已退出，返回码=%s%s" % (code, '（正常结束）' if code == 0 else '（异常退出，请检查上方最后的报错）'))
    def show_logs(self):
        self.tray_log("打开日志窗口（当前可见=%r）" % self.log_window.isVisible())
        try:
            self.log_window.showNormal()
            screen = QGuiApplication.screenAt(QCursor.pos()) or QGuiApplication.primaryScreen()
            area = screen.availableGeometry()
            frame = self.log_window.frameGeometry()
            frame.moveCenter(area.center())
            self.log_window.move(frame.topLeft())
            self.log_window.raise_(); self.log_window.activateWindow(); self.refresh_log()
            hwnd = int(self.log_window.winId())
            ctypes.windll.user32.ShowWindow(hwnd, 9)
            ctypes.windll.user32.SetWindowPos(hwnd, -1, 0, 0, 0, 0, 0x0047)
            ctypes.windll.user32.SetWindowPos(hwnd, -2, 0, 0, 0, 0, 0x0047)
            ctypes.windll.user32.SetForegroundWindow(hwnd)
            QTimer.singleShot(0, lambda: self._present_log_window(hwnd))
            self.tray_log("日志窗口已显示 可见=%r hwnd=%r 位置=%r" % (self.log_window.isVisible(), hwnd, self.log_window.geometry().getRect()))
        except Exception as error:
            self.tray_log("打开日志窗口失败: %r" % (error,))
            self.tray.showMessage("CodeAgenda", "日志窗口打开失败，请重试", QSystemTrayIcon.MessageIcon.Critical, 5000)

    def _present_log_window(self, hwnd):
        try:
            self.log_window.showNormal(); self.log_window.raise_(); self.log_window.activateWindow()
            ctypes.windll.user32.ShowWindow(hwnd, 9); ctypes.windll.user32.SetForegroundWindow(hwnd)
        except Exception as error:
            self.tray_log("日志窗口前置失败: %r" % (error,))

    def on_logs_action(self, checked=False):
        self.tray_log("托盘菜单「打开日志界面」被点击")
        self.show_logs()
    def open_web(self): self.tray_log("打开前端网页 %s" % WEB_URL); webbrowser.open(WEB_URL)
    def stop(self):
        self.stopping = True
        self.tray_log("关闭程序：正在停止后端...")
        if self.process is not None and self.process.poll() is None:
            self.process.terminate()
            try: self.process.wait(timeout=5)
            except subprocess.TimeoutExpired: self.process.kill()
            self.tray_log("后端已停止，返回码=%s" % self.process.returncode)
        self.tray.hide(); self.instance.release(); self.tray_log("托盘已退出，文件锁已释放"); self.qt.quit()
    def run(self):
        if not self.instance.acquire():
            # 已有实例在跑：不重复启动后端，只弹一张提示卡然后退出
            self.show_toast("CodeAgenda", "监控已开启，无需重复启动", "!", "#0a84ff")
            QTimer.singleShot(TOAST_MS + 800, self.qt.quit)
            self.qt.exec(); return False
        self.tray_log("CodeAgenda 托盘已启动 PID=%s 目录=%s 网页=%s" % (os.getpid(), BASE_DIR, WEB_URL))
        self.tray_log("已取得单实例锁 %s（上次残留会在这里被覆盖）" % LOCK_PATH)
        self.start_backend(); menu = QMenu()
        web_action = menu.addAction("打开前端网页"); web_action.triggered.connect(lambda checked=False: self.open_web())
        logs_action = menu.addAction("打开日志界面"); logs_action.triggered.connect(self.on_logs_action)
        self.tray_log("托盘菜单已就绪（打开前端网页 / 打开日志界面 / 关闭程序）")
        menu.addSeparator()
        close_action = menu.addAction("关闭程序"); close_action.triggered.connect(lambda checked=False: self.stop())
        self.tray.setContextMenu(menu); self.tray.activated.connect(lambda reason: self.open_web() if reason == QSystemTrayIcon.ActivationReason.Trigger else None); self.tray.show()
        # 等托盘图标出现再弹提示，视觉上像是图标的回应
        QTimer.singleShot(400, lambda: self.show_toast("CodeAgenda", "监控已开启"))
        self.qt.exec(); return True


if __name__ == "__main__": TrayApp().run()
