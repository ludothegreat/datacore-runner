#!/usr/bin/env python3
"""Dev server for Datacore Runner: the static files plus /api/stats for the F stats panel.

A web page is not allowed to read CPU load, memory or temperatures, so this process reads
them and hands them to the page as JSON. Standard library only, Linux only (/proc, /sys and
nvidia-smi); the Windows build gets these numbers from its desktop wrapper instead.

Run: python3 serve.py
"""

import argparse
import functools
import json
import logging
import shutil
import subprocess
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
HOST = "127.0.0.1"
PORT = 4173
MIN_SAMPLE_GAP = 0.9  # seconds; requests closer together than this share one sample
CPU_TEMP_DRIVERS = ("coretemp", "k10temp", "zenpower")

log = logging.getLogger("datacore.serve")


def read_cpu_times() -> tuple[int, int]:
    """(busy, total) jiffies summed over all cores since boot."""
    with open("/proc/stat", encoding="ascii") as fh:
        fields = [int(v) for v in fh.readline().split()[1:]]
    idle = fields[3] + fields[4]  # idle + iowait
    return sum(fields) - idle, sum(fields)


def read_memory() -> dict[str, float]:
    info: dict[str, int] = {}
    with open("/proc/meminfo", encoding="ascii") as fh:
        for line in fh:
            key, value = line.split(":", 1)
            info[key] = int(value.split()[0])  # kB
    return {
        "used_gb": (info["MemTotal"] - info["MemAvailable"]) / 1048576,
        "total_gb": info["MemTotal"] / 1048576,
    }


def find_cpu_temp_file() -> Path | None:
    for hwmon in sorted(Path("/sys/class/hwmon").glob("hwmon*")):
        name_file = hwmon / "name"
        if name_file.exists() and name_file.read_text().strip() in CPU_TEMP_DRIVERS:
            sensor = hwmon / "temp1_input"  # package temperature on all three drivers
            if sensor.exists():
                return sensor
    return None


def read_gpu() -> dict[str, float | str] | None:
    """First NVIDIA GPU via nvidia-smi. Raises if nvidia-smi is present but fails."""
    if shutil.which("nvidia-smi") is None:
        return None
    out = subprocess.run(
        ["nvidia-smi", "--query-gpu=name,utilization.gpu,temperature.gpu,memory.used,memory.total",
         "--format=csv,noheader,nounits"],
        capture_output=True, text=True, timeout=3, check=True,
    ).stdout.strip().splitlines()[0]
    name, load, temp, used, total = [part.strip() for part in out.split(",")]
    return {
        "name": name, "percent": float(load), "temp_c": float(temp),
        "vram_used_gb": float(used) / 1024, "vram_total_gb": float(total) / 1024,
    }


class Sampler:
    """Reads the machine on demand, at most once per MIN_SAMPLE_GAP, so nothing runs while the panel is off."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._cpu_prev = read_cpu_times()
        self._at = 0.0
        self._snapshot: dict[str, object] = {}
        self._cpu_temp_file = find_cpu_temp_file()
        self._gpu_error = ""
        log.debug("cpu temperature sensor: %s", self._cpu_temp_file)
        log.debug("nvidia-smi: %s", shutil.which("nvidia-smi"))
        if self._cpu_temp_file is None:
            log.warning("no CPU temperature sensor found (looked for %s)", ", ".join(CPU_TEMP_DRIVERS))

    def get(self) -> dict[str, object]:
        with self._lock:
            now = time.monotonic()
            if now - self._at < MIN_SAMPLE_GAP:
                return self._snapshot
            busy, total = read_cpu_times()
            d_busy = busy - self._cpu_prev[0]
            d_total = total - self._cpu_prev[1]
            self._cpu_prev = (busy, total)
            # The very first sample has nothing recent to compare with.
            cpu_percent = None if self._at == 0.0 or d_total <= 0 else 100 * d_busy / d_total
            cpu_temp = None
            if self._cpu_temp_file is not None:
                cpu_temp = int(self._cpu_temp_file.read_text()) / 1000

            gpu = None
            gpu_error = ""
            try:
                gpu = read_gpu()
            except (subprocess.SubprocessError, OSError, ValueError, IndexError) as exc:
                gpu_error = f"{type(exc).__name__}: {exc}"
            if gpu_error != self._gpu_error:
                # Logged when it starts and when it clears, not once a second.
                if gpu_error:
                    log.error("GPU read failed: %s", gpu_error)
                else:
                    log.info("GPU read recovered")
                self._gpu_error = gpu_error

            self._at = now
            self._snapshot = {
                "cpu": {"percent": cpu_percent, "temp_c": cpu_temp},
                "memory": read_memory(),
                "gpu": gpu,
                "gpu_error": gpu_error,
            }
            log.debug("sample %s", self._snapshot)
            return self._snapshot


class Handler(SimpleHTTPRequestHandler):
    sampler: Sampler

    def do_GET(self) -> None:
        if self.path.split("?", 1)[0] != "/api/stats":
            super().do_GET()
            return
        body = json.dumps(self.sampler.get()).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self) -> None:
        # Without this a browser may keep running an old main.js after an edit. no-cache still
        # allows a cheap "has it changed?" check, so unchanged files are not re-downloaded.
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, format: str, *args: object) -> None:
        # One line a second from the stats poll would bury everything else.
        if "/api/stats" in str(args[0] if args else ""):
            return
        log.info("%s %s", self.address_string(), format % args)


def main() -> None:
    parser = argparse.ArgumentParser(description="Datacore Runner dev server with PC stats")
    parser.add_argument("--port", type=int, default=PORT)
    parser.add_argument("--quiet", action="store_true", help="log warnings and errors only")
    args = parser.parse_args()
    logging.basicConfig(
        level=logging.WARNING if args.quiet else logging.DEBUG,
        format="%(asctime)s %(levelname)s %(name)s %(message)s", datefmt="%H:%M:%S",
    )
    Handler.sampler = Sampler()
    # Loopback only: this serves the project folder and machine stats, neither belongs on the network.
    server = ThreadingHTTPServer((HOST, args.port), functools.partial(Handler, directory=str(ROOT)))
    log.info("serving %s at http://%s:%d/index.html", ROOT, HOST, args.port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info("stopped")


if __name__ == "__main__":
    main()
