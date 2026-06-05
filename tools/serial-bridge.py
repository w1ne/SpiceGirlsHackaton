#!/usr/bin/env python3
"""Serial <-> browser bridge for the SpiceDispenser console.

The ESP32-S3's built-in USB-Serial-JTAG resets the chip every time a host opens
the port while pulsing DTR/RTS — which makes the browser's Web Serial API loop
forever (open -> reset -> device lost -> reopen -> reset...). This bridge dodges
that: it opens the port ONCE with DTR/RTS held inactive (no reset), keeps it
open, and exposes the stream to the browser over ordinary HTTP — so the page
works in any browser, no Web Serial needed.

    python3 tools/serial-bridge.py            # auto-detect /dev/ttyACM*
    python3 tools/serial-bridge.py /dev/ttyACM1 --port 8000

Then open http://localhost:8000/ and click Connect.

  GET  /            -> the console page (tools/serial-console.html)
  GET  /events      -> text/event-stream, one event per serial line
  POST /send        -> body is a JSON command line, written to the serial port
"""
import sys, os, glob, time, threading, queue, argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    import serial
except ImportError:
    sys.exit("pyserial missing: pip install --user pyserial")

HERE = os.path.dirname(os.path.abspath(__file__))
HTML = os.path.join(HERE, "serial-console.html")

subscribers = set()          # set[queue.Queue] — one per open /events stream
subscribers_lock = threading.Lock()
ser = None                   # the live serial.Serial


def publish(line):
    with subscribers_lock:
        for q in list(subscribers):
            q.put(line)


def reader_thread():
    """Read the port forever, re-opening if the board re-enumerates."""
    global ser
    buf = b""
    while True:
        if ser is None or not ser.is_open:
            try:
                path = (glob.glob("/dev/ttyACM*") or glob.glob("/dev/ttyUSB*") or [DEVICE])[0]
                s = serial.Serial()
                s.port = path
                s.baudrate = 115200
                s.timeout = 0.2
                # Hold reset/boot lines inactive BEFORE opening so the S3 doesn't
                # reboot on open (this is the whole point of the bridge).
                s.dtr = False
                s.rts = False
                s.open()
                ser = s
                publish('{"bridge":"opened","port":"%s"}' % path)
            except Exception as e:
                publish('{"bridge":"waiting","msg":"%s"}' % str(e).replace('"', "'"))
                time.sleep(1)
                continue
        try:
            data = ser.read(256)
            if data:
                buf += data
                while b"\n" in buf or b"\r" in buf:
                    i = min((buf.find(b) for b in (b"\n", b"\r") if b in buf))
                    line = buf[:i].decode("utf-8", "replace").strip()
                    buf = buf[i + 1:]
                    if line:
                        publish(line)
        except Exception:
            try: ser.close()
            except Exception: pass
            ser = None
            publish('{"bridge":"lost"}')
            time.sleep(0.5)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # quiet
        pass

    def do_GET(self):
        if self.path == "/" or self.path.startswith("/index"):
            with open(HTML, "rb") as f:
                body = f.read()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif self.path == "/events":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            q = queue.Queue()
            with subscribers_lock:
                subscribers.add(q)
            try:
                while True:
                    try:
                        line = q.get(timeout=15)
                        self.wfile.write(b"data: " + line.encode("utf-8", "replace") + b"\n\n")
                    except queue.Empty:
                        self.wfile.write(b": ping\n\n")   # keep the connection warm
                    self.wfile.flush()
            except Exception:
                pass
            finally:
                with subscribers_lock:
                    subscribers.discard(q)
        else:
            self.send_error(404)

    def do_POST(self):
        if self.path != "/send":
            self.send_error(404); return
        n = int(self.headers.get("Content-Length", 0))
        line = self.rfile.read(n).decode("utf-8", "replace").strip()
        ok = False
        if ser and ser.is_open and line:
            try:
                ser.write((line + "\n").encode()); ser.flush(); ok = True
            except Exception:
                ok = False
        self.send_response(200 if ok else 503)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(b'{"sent":true}' if ok else b'{"sent":false}')


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("device", nargs="?", default="/dev/ttyACM0")
    ap.add_argument("--port", type=int, default=8000)
    args = ap.parse_args()
    DEVICE = args.device
    threading.Thread(target=reader_thread, daemon=True).start()
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print("SpiceDispenser bridge on http://localhost:%d/  (Ctrl-C to stop)" % args.port)
    print("serial: auto-detecting /dev/ttyACM* — board boots ONCE, then stays up")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")
