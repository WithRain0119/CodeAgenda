# -*- coding: utf-8 -*-
"""CodeAgenda tray launcher and Qt log window."""
from __future__ import annotations
import ctypes, os, subprocess, sys, threading, webbrowser
from pathlib import Path
from PyQt6.QtCore import QEasingCurve, QPropertyAnimation, QTimer, Qt
from PyQt6.QtGui import QColor, QCursor, QFont, QGuiApplication, QIcon
from PyQt6.QtWidgets import QApplication, QFrame, QGraphicsDropShadowEffect, QHBoxLayout, QLabel, QMainWindow, QMenu, QPlainTextEdit, QSystemTrayIcon, QVBoxLayout, QWidget

try:
    import msvcrt
except ImportError:
    msvcrt = None

BASE_DIR = Path(__file__).resolve().parent
LOCK_PATH = BASE_DIR / ".codeagenda.lock"
WEB_URL = os.environ.get("CODEAGENDA_URL", "http://127.0.0.1:5000")
ICON_PATH = BASE_DIR / "static" / "favicon.svg"


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
    def __init__(self, icon):
        super().__init__(); self.setWindowTitle("CodeAgenda 日志"); self.setWindowIcon(icon); self.resize(760, 480); self.setMinimumSize(520, 320)
        self.setWindowFlags(Qt.WindowType.Window | Qt.WindowType.WindowTitleHint | Qt.WindowType.WindowCloseButtonHint | Qt.WindowType.WindowMinimizeButtonHint)
        self.setStyleSheet("QMainWindow{background:#f5f5f7;} QLabel{color:#1d1d1f;} QPlainTextEdit{background:#fff;color:#1d1d1f;border:1px solid #e5e5e7;border-radius:12px;padding:12px;selection-background-color:#cfe3ff;} QScrollBar:vertical{width:10px;background:transparent;margin:4px;} QScrollBar::handle:vertical{background:#c7c7cc;border-radius:5px;min-height:30px;}")
        title = QLabel("运行日志"); title.setFont(QFont("Segoe UI", 18, QFont.Weight.Bold))
        self.text = QPlainTextEdit(); self.text.setReadOnly(True); self.text.setLineWrapMode(QPlainTextEdit.LineWrapMode.NoWrap)
        layout = QVBoxLayout(); layout.setContentsMargins(24, 22, 24, 24); layout.setSpacing(14); layout.addWidget(title); layout.addWidget(self.text)
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
        self.setFixedWidth(340)

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

        row = QHBoxLayout(card); row.setContentsMargins(16, 14, 18, 14); row.setSpacing(12)
        row.addWidget(badge, 0, Qt.AlignmentFlag.AlignTop); row.addLayout(column, 1)

        # 外层留白，供投影绘制；窗口四周会多出 16px 透明边距
        outer = QVBoxLayout(self); outer.setContentsMargins(16, 16, 16, 16); outer.addWidget(card)

        self.fade_in = QPropertyAnimation(self, b"windowOpacity", self)
        self.fade_in.setDuration(220); self.fade_in.setStartValue(0.0); self.fade_in.setEndValue(1.0)
        self.fade_in.setEasingCurve(QEasingCurve.Type.OutCubic)
        self.fade_out = QPropertyAnimation(self, b"windowOpacity", self)
        self.fade_out.setDuration(320); self.fade_out.setEndValue(0.0)
        self.fade_out.setEasingCurve(QEasingCurve.Type.InCubic)
        self.fade_out.finished.connect(self.close)

    def popup(self, duration=TOAST_MS):
        """贴右下角（任务栏上方）弹出，duration 毫秒后自动淡出关闭。"""
        self.adjustSize()
        area = QGuiApplication.primaryScreen().availableGeometry()
        self.move(area.right() + 1 - self.width(), area.bottom() + 1 - self.height())
        self.setWindowOpacity(0.0); self.show(); self.fade_in.start()
        QTimer.singleShot(duration, self.dismiss)

    def dismiss(self):
        if not self.isVisible(): return
        self.fade_in.stop()
        self.fade_out.setStartValue(self.windowOpacity()); self.fade_out.start()


class TrayApp:
    def __init__(self):
        self.instance = SingleInstance(LOCK_PATH); self.process = None; self.log_lines = []; self.log_lock = threading.Lock()
        self.qt = QApplication(sys.argv); self.qt.setQuitOnLastWindowClosed(False)
        self.icon = QIcon(str(ICON_PATH)); self.tray = QSystemTrayIcon(self.icon); self.tray.setToolTip("CodeAgenda")
        self.log_window = LogWindow(self.icon); self.timer = QTimer(); self.timer.timeout.connect(self.refresh_log); self.timer.start(250)
        self.toast = None
    def show_toast(self, title, message, glyph="✓", accent="#34c759"):
        self.toast = Toast(title, message, glyph, accent); self.toast.popup(); return self.toast
    def debug(self, message):
        try:
            with open(BASE_DIR / "tray_debug.log", "a", encoding="utf-8") as file:
                file.write(message + "\n"); file.flush()
        except OSError:
            pass
    def append_log(self, line):
        line = line.rstrip("\r\n")
        if line:
            with self.log_lock: self.log_lines.append(line)
    def read_output(self, stream):
        for line in iter(stream.readline, ""): self.append_log(line)
        stream.close()
    def start_backend(self):
        command = [sys.executable, "-u", str(BASE_DIR / "app.py")]; self.append_log("CodeAgenda 后端启动: " + " ".join(command))
        env = os.environ.copy(); env["PYTHONIOENCODING"] = "utf-8"
        self.process = subprocess.Popen(command, cwd=BASE_DIR, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace", env=env, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        threading.Thread(target=self.read_output, args=(self.process.stdout,), daemon=True).start()
    def refresh_log(self):
        with self.log_lock: content = "\n".join(self.log_lines)
        if self.log_window.text.toPlainText() != content:
            self.log_window.text.setPlainText(content); bar = self.log_window.text.verticalScrollBar(); bar.setValue(bar.maximum())
    def show_logs(self):
        self.debug("show_logs called")
        try:
            self.debug("window=%r visible=%r" % (self.log_window, self.log_window.isVisible()))
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
            self.debug("show_logs completed visible=%r hwnd=%r geometry=%r" % (self.log_window.isVisible(), hwnd, self.log_window.geometry().getRect()))
        except Exception as error:
            self.debug("show_logs error: %r" % (error,))
            self.tray.showMessage("CodeAgenda", "日志窗口打开失败，请查看 tray_debug.log", QSystemTrayIcon.MessageIcon.Critical, 5000)

    def _present_log_window(self, hwnd):
        try:
            self.log_window.showNormal(); self.log_window.raise_(); self.log_window.activateWindow()
            ctypes.windll.user32.ShowWindow(hwnd, 9); ctypes.windll.user32.SetForegroundWindow(hwnd)
            self.debug("deferred present visible=%r geometry=%r" % (self.log_window.isVisible(), self.log_window.geometry().getRect()))
        except Exception as error:
            self.debug("deferred present error: %r" % (error,))

    def on_logs_action(self, checked=False):
        self.debug("logs QAction triggered checked=%r" % checked)
        self.show_logs()
    def open_web(self): webbrowser.open(WEB_URL)
    def stop(self):
        if self.process is not None and self.process.poll() is None:
            self.append_log("正在关闭 CodeAgenda 后端..."); self.process.terminate()
            try: self.process.wait(timeout=5)
            except subprocess.TimeoutExpired: self.process.kill()
        self.tray.hide(); self.instance.release(); self.qt.quit()
    def run(self):
        if not self.instance.acquire():
            # 已有实例在跑：不重复启动后端，只弹一张提示卡然后退出
            self.show_toast("CodeAgenda", "监控已开启，无需重复启动", "!", "#0a84ff")
            QTimer.singleShot(TOAST_MS + 800, self.qt.quit)
            self.qt.exec(); return False
        self.start_backend(); menu = QMenu()
        web_action = menu.addAction("打开前端网页"); web_action.triggered.connect(lambda checked=False: self.open_web())
        logs_action = menu.addAction("打开日志界面"); logs_action.triggered.connect(self.on_logs_action)
        self.debug("logs QAction connected")
        menu.addSeparator()
        close_action = menu.addAction("关闭程序"); close_action.triggered.connect(lambda checked=False: self.stop())
        self.tray.setContextMenu(menu); self.tray.activated.connect(lambda reason: self.open_web() if reason == QSystemTrayIcon.ActivationReason.Trigger else None); self.tray.show()
        # 等托盘图标出现再弹提示，视觉上像是图标的回应
        QTimer.singleShot(400, lambda: self.show_toast("CodeAgenda", "监控已开启"))
        self.qt.exec(); return True


if __name__ == "__main__": TrayApp().run()
