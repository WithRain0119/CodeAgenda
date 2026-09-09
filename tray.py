# -*- coding: utf-8 -*-
"""CodeAgenda Windows tray launcher.

The tray process owns the Flask child process, so there is one lifecycle and
one single-instance lock for the whole application.
"""
from __future__ import annotations

import os
import subprocess
import sys
import threading
import tkinter as tk
from pathlib import Path
from tkinter import ttk
import webbrowser

import pystray
from PIL import Image, ImageDraw

try:
    import msvcrt
except ImportError:  # pragma: no cover - this launcher targets Windows
    msvcrt = None


BASE_DIR = Path(__file__).resolve().parent
LOCK_PATH = BASE_DIR / ".codeagenda.lock"
WEB_URL = os.environ.get("CODEAGENDA_URL", "http://127.0.0.1:5000")


class SingleInstance:
    def __init__(self, path: Path):
        self.path = path
        self.handle = None

    def acquire(self) -> bool:
        if msvcrt is None:
            return True
        self.handle = open(self.path, "a+")
        try:
            self.handle.seek(0)
            if not self.handle.read(1):
                self.handle.write("0")
                self.handle.flush()
        except OSError:
            # A running instance may hold the file exclusively on Windows.
            self.handle.close()
            self.handle = None
            return False
        self.handle.seek(0)
        try:
            msvcrt.locking(self.handle.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            self.handle.close()
            self.handle = None
            return False
        self.handle.seek(0)
        self.handle.truncate()
        self.handle.write(str(os.getpid()))
        self.handle.flush()
        return True

    def release(self):
        if self.handle is None:
            return
        try:
            self.handle.seek(0)
            msvcrt.locking(self.handle.fileno(), msvcrt.LK_UNLCK, 1)
        finally:
            self.handle.close()
            self.handle = None


def make_icon() -> Image.Image:
    """Draw the same blue/white calendar motif used by static/favicon.svg."""
    image = Image.new("RGBA", (64, 64), (9, 105, 218, 255))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((13, 17, 51, 51), radius=5, fill="white")
    draw.line((13, 27, 51, 27), fill=(9, 105, 218), width=4)
    draw.line((22, 12, 22, 22), fill="white", width=5)
    draw.line((42, 12, 42, 22), fill="white", width=5)
    for x, y in ((20, 33), (29, 33), (38, 33), (20, 42), (29, 42)):
        draw.rounded_rectangle((x, y, x + 6, y + 6), radius=1, fill=(9, 105, 218))
    return image


class TrayApp:
    def __init__(self):
        self.instance = SingleInstance(LOCK_PATH)
        self.process = None
        self.log_lines = []
        self.log_lock = threading.Lock()
        self.root = tk.Tk()
        self.root.withdraw()
        self.log_window = None
        self.log_text = None
        self.icon = pystray.Icon("CodeAgenda", make_icon(), "CodeAgenda")

    def append_log(self, line: str):
        line = line.rstrip("\r\n")
        if not line:
            return
        with self.log_lock:
            self.log_lines.append(line)
        if self.log_text is not None and self.log_window is not None and self.log_window.winfo_exists():
            self.root.after(0, self._refresh_log)

    def _read_output(self, stream):
        for line in iter(stream.readline, ""):
            self.append_log(line)
        stream.close()

    def start_backend(self):
        command = [sys.executable, "-u", str(BASE_DIR / "app.py")]
        self.append_log("CodeAgenda 后端启动: " + " ".join(command))
        environment = os.environ.copy()
        environment["PYTHONIOENCODING"] = "utf-8"
        self.process = subprocess.Popen(
            command, cwd=BASE_DIR, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="replace", env=environment,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        threading.Thread(target=self._read_output, args=(self.process.stdout,), daemon=True).start()

    def _refresh_log(self):
        if self.log_text is None:
            return
        with self.log_lock:
            content = "\n".join(self.log_lines)
        self.log_text.configure(state="normal")
        self.log_text.delete("1.0", "end")
        self.log_text.insert("end", content)
        self.log_text.see("end")
        self.log_text.configure(state="disabled")

    def show_logs(self, *_):
        self.root.after(0, self._show_logs_window)

    def _show_logs_window(self):
        if self.log_window is not None and self.log_window.winfo_exists():
            self.log_window.deiconify()
            self.log_window.lift()
            self._refresh_log()
            return
        win = self.log_window = tk.Toplevel(self.root)
        win.title("CodeAgenda 日志")
        win.geometry("680x420")
        win.minsize(480, 260)
        win.configure(bg="#f5f5f7")
        win.protocol("WM_DELETE_WINDOW", win.withdraw)
        frame = ttk.Frame(win, padding=16)
        frame.pack(fill="both", expand=True)
        ttk.Label(frame, text="运行日志", font=("Segoe UI", 16, "bold")).pack(anchor="w", pady=(0, 10))
        text_frame = ttk.Frame(frame)
        text_frame.pack(fill="both", expand=True)
        self.log_text = tk.Text(text_frame, wrap="word", bg="#ffffff", fg="#1d1d1f", relief="flat", borderwidth=0,
                                font=("Consolas", 10), padx=12, pady=10, state="disabled")
        scroll = ttk.Scrollbar(text_frame, command=self.log_text.yview)
        self.log_text.configure(yscrollcommand=scroll.set)
        self.log_text.pack(side="left", fill="both", expand=True)
        scroll.pack(side="right", fill="y")
        self._refresh_log()

    def open_web(self, *_):
        webbrowser.open(WEB_URL)

    def stop(self, *_):
        if self.process is not None and self.process.poll() is None:
            self.append_log("正在关闭 CodeAgenda 后端...")
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
        self.icon.stop()
        self.instance.release()
        self.root.after(0, self.root.destroy)

    def run(self):
        if not self.instance.acquire():
            return False
        self.start_backend()
        menu = pystray.Menu(
            pystray.MenuItem("打开前端网页", self.open_web, default=True),
            pystray.MenuItem("打开日志界面", self.show_logs),
            pystray.MenuItem("关闭程序", self.stop),
        )
        self.icon.menu = menu
        threading.Thread(target=self.icon.run, daemon=True).start()
        self.root.mainloop()
        return True


if __name__ == "__main__":
    TrayApp().run()
