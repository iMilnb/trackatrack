#!/usr/bin/env python3
"""Headless screenshot via CDP. Usage: shot.py URL OUT.png [--w N] [--h N] [--dsf N] [--wait JSEXPR] [--clip x,y,w,h] [--geom JSEXPR]"""
import base64
import json
import os
import socket
import struct
import subprocess
import sys
import time

args = sys.argv[1:]
URL = args[0]
OUT = args[1]
rest = args[2:]


def opt(name, default=None):
    return rest[rest.index(name) + 1] if name in rest else default


W = int(opt("--w", 1920))
H = int(opt("--h", 1080))
DSF = float(opt("--dsf", 1))
WAIT = opt("--wait")
GEOM = opt("--geom")
CLIP = [int(v) for v in opt("--clip", "").split(",")] if opt("--clip") else None
PORT = 9334


def ws_connect(ws_url):
    path = ws_url.split(str(PORT), 1)[1]
    key = base64.b64encode(os.urandom(16)).decode()
    s = socket.create_connection(("127.0.0.1", PORT), timeout=120)
    s.sendall(
        ("GET %s HTTP/1.1\r\nHost: 127.0.0.1:%d\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
         "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n" % (path, PORT, key)).encode()
    )
    buf = b""
    while b"\r\n\r\n" not in buf:
        buf += s.recv(1)
    return s


def ws_send(s, obj):
    data = json.dumps(obj).encode()
    mask = os.urandom(4)
    hdr = b"\x81"
    n = len(data)
    if n < 126:
        hdr += bytes([0x80 | n])
    elif n < 65536:
        hdr += bytes([0x80 | 126]) + struct.pack(">H", n)
    else:
        hdr += bytes([0x80 | 127]) + struct.pack(">Q", n)
    s.sendall(hdr + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))


def ws_recv(s):
    def rd(n):
        buf = b""
        while len(buf) < n:
            c = s.recv(n - len(buf))
            if not c:
                raise EOFError
            buf += c
        return buf
    b0, b1 = rd(2)
    n = b1 & 0x7F
    if n == 126:
        n = struct.unpack(">H", rd(2))[0]
    elif n == 127:
        n = struct.unpack(">Q", rd(8))[0]
    data = rd(n)
    return json.loads(data)


def main():
    proc = subprocess.Popen(
        ["google-chrome", "--headless=new", "--no-first-run", "--disable-gpu", "--ignore-certificate-errors",
         "--remote-debugging-port=%d" % PORT, "--user-data-dir=/tmp/tjs-shot-%d" % os.getpid(), "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        import urllib.request
        target = None
        for _ in range(60):
            time.sleep(0.5)
            try:
                tabs = json.load(urllib.request.urlopen("http://127.0.0.1:%d/json/list" % PORT, timeout=2))
                pages = [t for t in tabs if t.get("type") == "page"]
                if pages:
                    target = pages[0]["webSocketDebuggerUrl"]
                    break
            except Exception:
                pass
        if not target:
            print("no CDP target")
            return 1
        s = ws_connect(target)
        mid = [10]

        def cmd(method, params=None):
            mid[0] += 1
            ws_send(s, {"id": mid[0], "method": method, "params": params or {}})
            while True:
                msg = ws_recv(s)
                if msg.get("id") == mid[0]:
                    return msg.get("result", {})

        cmd("Page.enable")
        cmd("Runtime.enable")
        cmd("Emulation.setDeviceMetricsOverride",
            {"width": W, "height": H, "deviceScaleFactor": DSF, "mobile": False})
        cmd("Page.navigate", {"url": URL})
        for _ in range(60):
            r = cmd("Runtime.evaluate", {"expression": "document.readyState"})
            if r.get("result", {}).get("value") == "complete":
                break
            time.sleep(0.4)
        if WAIT:
            for _ in range(240):
                r = cmd("Runtime.evaluate", {"expression": WAIT, "awaitPromise": True})
                if r.get("result", {}).get("value"):
                    break
                time.sleep(0.5)
        time.sleep(1.0)
        if GEOM:
            r = cmd("Runtime.evaluate", {"expression": GEOM, "returnByValue": True})
            print("GEOM " + json.dumps(r.get("result", {}).get("value")))
        params = {"format": "png", "captureBeyondViewport": True}
        if CLIP:
            params["clip"] = {"x": CLIP[0], "y": CLIP[1], "width": CLIP[2], "height": CLIP[3], "scale": DSF}
        r = cmd("Page.captureScreenshot", params)
        with open(OUT, "wb") as f:
            f.write(base64.b64decode(r["data"]))
        print(OUT)
        return 0
    finally:
        proc.terminate()
        proc.wait(timeout=5)


sys.exit(main())
