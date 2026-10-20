#!/usr/bin/env python3
"""Eval JS in a headless Chrome page via CDP (stdlib only). Usage: cdp_eval.py URL [JS-expression]"""
import base64
import json
import os
import socket
import struct
import subprocess
import sys
import time

URL = sys.argv[1] if len(sys.argv) > 1 else "about:blank"
EXPR = sys.argv[2] if len(sys.argv) > 2 else "1+1"
PORT = 9333


def ws_connect(ws_url):
    # ws://127.0.0.1:PORT/devtools/page/ID
    path = ws_url.split(str(PORT), 1)[1]
    key = base64.b64encode(os.urandom(16)).decode()
    s = socket.create_connection(("127.0.0.1", PORT), timeout=90)
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
    if b0 & 0x80:  # masked (client->server only, but be safe)
        m = rd(4) if b1 & 0x80 else None
        data = bytes(c ^ m[i % 4] for i, c in enumerate(data)) if m else data
    return json.loads(data)


def main():
    proc = subprocess.Popen(
        ["google-chrome", "--headless=new", "--no-first-run", "--disable-gpu", "--ignore-certificate-errors", "--autoplay-policy=no-user-gesture-required",
         "--remote-debugging-port=%d" % PORT, "--user-data-dir=/tmp/tjs-cdp-%d" % os.getpid(), "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    target = None
    try:
        import urllib.request
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
        try:
            origin = URL.split("//", 1)[0] + "//" + URL.split("//", 1)[1].split("/", 1)[0]
            cmd("Browser.grantPermissions", {"origin": origin, "permissions": ["midi", "midiSysex"]})
        except Exception:
            pass
        cmd("Page.navigate", {"url": URL})
        for _ in range(60):
            r = cmd("Runtime.evaluate", {"expression": "document.readyState"})
            if r.get("result", {}).get("value") == "complete":
                break
            time.sleep(0.4)
        r = cmd("Runtime.evaluate", {"expression": EXPR, "awaitPromise": True, "returnByValue": True})
        if "exceptionDetails" in r:
            exc = r["exceptionDetails"]
            print("EXC:", json.dumps(exc.get("exception", {}).get("description", exc.get("text"))))
            return 2
        print(r.get("result", {}).get("value"))
        return 0
    finally:
        proc.terminate()
        proc.wait(timeout=5)


sys.exit(main())
