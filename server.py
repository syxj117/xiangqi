#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
中国象棋 - 静态托管 + 运行日志收集服务

功能:
1. 托管项目静态文件 (index.html / style.css / game.js)
2. 接收 POST /log 请求, 将游戏运行日志写入 logs/ 目录
3. 同步输出到 stdout, 便于实时查看

用法:
    python3 server.py            # 默认 0.0.0.0:8080
    python3 server.py 9000       # 指定端口
"""

import json
import os
import sys
import datetime
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, unquote


# ---------- 路径 ----------
ROOT = os.path.dirname(os.path.abspath(__file__))
LOG_DIR = os.path.join(ROOT, "logs")
os.makedirs(LOG_DIR, exist_ok=True)

# 静态文件 MIME 映射
MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".txt": "text/plain; charset=utf-8",
    ".ico": "image/x-icon",
}

# 允许写入日志的级别
LEVELS = ("debug", "info", "warn", "error")


# ---------- 日志写入 ----------
def write_log(level, event, data):
    """写入一条日志到当天文件, 同时输出到 stdout"""
    level = (level or "info").lower()
    if level not in LEVELS:
        level = "info"
    ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
    data_str = ""
    if data is not None:
        if isinstance(data, (dict, list)):
            try:
                data_str = " " + json.dumps(data, ensure_ascii=False, separators=(",", ":"))
            except Exception:
                data_str = " " + repr(data)
        elif data != "":
            data_str = " " + str(data)
    line = "{ts} [{lvl:5}] event={event}{data}".format(
        ts=ts, lvl=level.upper(), event=event or "-", data=data_str
    )

    # 写入当天文件
    fname = datetime.datetime.now().strftime("game-%Y-%m-%d.log")
    path = os.path.join(LOG_DIR, fname)
    try:
        with open(path, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception as e:
        sys.stderr.write("[server] failed to write log: {}\n".format(e))

    # 同步输出到 stdout
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


# ---------- HTTP Handler ----------
class Handler(BaseHTTPRequestHandler):
    server_version = "XiangqiServer/1.0"

    # 静态文件托管
    def do_GET(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)

        # 首页
        if path == "/" or path == "":
            path = "/index.html"

        # 安全检查: 防止目录穿越
        rel = path.lstrip("/")
        full = os.path.normpath(os.path.join(ROOT, rel))
        if not full.startswith(ROOT) or not os.path.isfile(full):
            self.send_error(404, "Not Found: {}".format(path))
            return

        ext = os.path.splitext(full)[1].lower()
        ctype = MIME.get(ext, "application/octet-stream")
        try:
            with open(full, "rb") as f:
                content = f.read()
        except Exception as e:
            self.send_error(500, "Read error: {}".format(e))
            return

        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(content)

    # 日志收集 / AI 代理 接口
    def do_POST(self):
        parsed = urlparse(self.path)

        # ---------- AI 代理 ----------
        if parsed.path == "/ai-proxy":
            self._handle_ai_proxy()
            return

        # ---------- 日志收集 ----------
        if parsed.path != "/log":
            self.send_error(404, "Not Found")
            return

        length = int(self.headers.get("Content-Length", 0) or 0)
        raw = self.rfile.read(length) if length > 0 else b""
        try:
            payload = json.loads(raw.decode("utf-8")) if raw else {}
        except Exception as e:
            self._respond_json(400, {"ok": False, "error": "invalid json: {}".format(e)})
            return

        if not isinstance(payload, dict):
            self._respond_json(400, {"ok": False, "error": "payload must be object"})
            return

        level = payload.get("level", "info")
        event = payload.get("event", "unknown")
        data = payload.get("data")
        write_log(level, event, data)

        self._respond_json(200, {"ok": True})

    def _handle_ai_proxy(self):
        """转发请求到 OpenAI 兼容的 /chat/completions 接口, 规避浏览器 CORS"""
        length = int(self.headers.get("Content-Length", 0) or 0)
        raw = self.rfile.read(length) if length > 0 else b""
        try:
            payload = json.loads(raw.decode("utf-8")) if raw else {}
        except Exception as e:
            self._respond_json(400, {"ok": False, "error": "invalid json: {}".format(e)})
            return

        base_url = (payload.get("baseUrl") or "").strip().rstrip("/")
        api_key = (payload.get("apiKey") or "").strip()
        model = (payload.get("model") or "").strip()
        messages = payload.get("messages")

        if not base_url or not api_key or not model or not messages:
            self._respond_json(400, {"ok": False, "error": "baseUrl, apiKey, model, messages are required"})
            return

        target = base_url + "/chat/completions"
        body = json.dumps({
            "model": model,
            "messages": messages,
            "temperature": payload.get("temperature", 0.7),
            "max_tokens": payload.get("max_tokens", 256),
        }).encode("utf-8")

        req = urllib.request.Request(target, data=body, method="POST")
        req.add_header("Content-Type", "application/json")
        req.add_header("Authorization", "Bearer {}".format(api_key))

        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                data = resp.read()
            result = json.loads(data.decode("utf-8"))
            write_log("info", "ai_proxy", {"model": model, "target": target})
            self._respond_json(200, {"ok": True, "data": result})
        except urllib.error.HTTPError as e:
            err_body = ""
            try:
                err_body = e.read().decode("utf-8", errors="replace")
            except Exception:
                pass
            write_log("error", "ai_proxy_http_error", {"code": e.code, "body": err_body[:500]})
            self._respond_json(502, {"ok": False, "error": "upstream HTTP {}: {}".format(e.code, err_body[:500])})
        except Exception as e:
            write_log("error", "ai_proxy_error", {"error": str(e)})
            self._respond_json(502, {"ok": False, "error": str(e)})

    def _respond_json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    # 允许跨域预检 (本地调试时浏览器与不同源端口可能用到)
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    # 静默常规访问日志, 自定义日志走 write_log
    def log_message(self, *args, **kwargs):
        return


def main():
    port = 8080
    if len(sys.argv) >= 2:
        try:
            port = int(sys.argv[1])
        except ValueError:
            sys.stderr.write("invalid port: {}\n".format(sys.argv[1]))
            sys.exit(1)

    write_log("info", "server_start", {"port": port, "root": ROOT, "log_dir": LOG_DIR})
    httpd = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        write_log("info", "server_stop", None)
        httpd.server_close()


if __name__ == "__main__":
    main()
