#!/usr/bin/env python3
"""Start the triage server with the Groq key and verify the /home frontend."""
import os
import sys
import json
import time
import glob
import socket
import subprocess
import urllib.request
import urllib.error
import http.cookiejar

BASE = os.path.dirname(os.path.abspath(__file__))
PY = os.path.join(BASE, ".venv", "Scripts", "python.exe")
GROQ = "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"
PORT = 8000


def port_pids():
    r = subprocess.run(["netstat", "-ano"], capture_output=True, text=True)
    pids = set()
    for line in r.stdout.splitlines():
        if ":%d" % PORT in line and "LISTENING" in line:
            parts = line.split()
            if parts and parts[-1].isdigit():
                pids.add(int(parts[-1]))
    return pids


def main():
    print("=" * 54)
    print("TRIAGE SERVER LAUNCHER")
    print("=" * 54)

    print("[1] Freeing port %d" % PORT)
    for pid in port_pids():
        subprocess.run(["taskkill", "/F", "/PID", str(pid)],
                       capture_output=True, text=True)
        print("    killed PID %d" % pid)
    time.sleep(2)

    print("[2] Removing qdrant lock files")
    for lock in glob.glob(os.path.join(BASE, "data", "**", "*.lock"), recursive=True):
        try:
            os.remove(lock)
            print("    removed %s" % os.path.basename(os.path.dirname(lock)))
        except Exception as e:
            print("    ! %s" % e)

    print("[3] Writing GROQ_API_KEY into .env")
    envp = os.path.join(BASE, ".env")
    try:
        with open(envp) as f:
            content = f.read()
    except Exception:
        content = ""
    lines = [l for l in content.splitlines()
             if not l.strip().startswith("GROQ_API_KEY")]
    lines.insert(0, "GROQ_API_KEY=%s" % GROQ)
    with open(envp, "w") as f:
        f.write("\n".join(lines) + "\n")

    print("[4] Using GROQ_API_KEY (from .env)")
    print("[5] Starting uvicorn on 0.0.0.0:%d" % PORT)
    log = open(os.path.join(BASE, "server.log"), "w", buffering=1)
    proc = subprocess.Popen(
        [PY, "-m", "uvicorn", "app:app",
         "--host", "0.0.0.0", "--port", str(PORT)],
        cwd=BASE, stdout=log, stderr=subprocess.STDOUT, text=True)
    print("    PID %d" % proc.pid)

    HTTPS_PORT = 8443
    certfile = os.path.join(BASE, "certs", "cert.pem")
    keyfile = os.path.join(BASE, "certs", "key.pem")
    proc2 = None
    if os.path.exists(certfile) and os.path.exists(keyfile):
        print("[5b] Starting HTTPS uvicorn on 0.0.0.0:%d (voice for LAN)" % HTTPS_PORT)
        log2 = open(os.path.join(BASE, "server.https.log"), "w", buffering=1)
        proc2 = subprocess.Popen(
            [PY, "-m", "uvicorn", "app:app",
             "--host", "0.0.0.0", "--port", str(HTTPS_PORT),
             "--ssl-certfile", certfile, "--ssl-keyfile", keyfile],
            cwd=BASE, stdout=log2, stderr=subprocess.STDOUT, text=True)
        print("    PID %d" % proc2.pid)
    else:
        print("[5b] Skipping HTTPS — certs/cert.pem + key.pem missing (generate them first).")

    print("[6] Waiting for server")
    ok = False
    for i in range(40):
        time.sleep(1.5)
        if proc.poll() is not None:
            print("    !! process exited at attempt %d" % (i + 1))
            break
        try:
            code = urllib.request.urlopen(
                "http://127.0.0.1:%d/health" % PORT, timeout=3).status
            ok = True
            print("    health OK (attempt %d)" % (i + 1))
            break
        except Exception:
            pass

    if not ok:
        print("\n!! SERVER FAILED TO START")
        log.flush()
        log.close()
        with open(os.path.join(BASE, "server.log")) as f:
            print(f.read()[-3000:])
        sys.exit(1)

    print("[7] Verifying login + /home")
    cj = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    try:
        r = op.open(urllib.request.Request(
            "http://127.0.0.1:%d/login" % PORT,
            data=json.dumps({"email": "doctor@test.com",
                             "password": "doctor123"}).encode(),
            headers={"Content-Type": "application/json"}), timeout=30)
        print("    /login %s" % r.status)
    except urllib.error.HTTPError as e:
        print("    /login HTTP %d" % e.code)
    except Exception as e:
        print("    /login %s" % e)

    try:
        r = op.open(urllib.request.Request(
            "http://127.0.0.1:%d/home" % PORT, headers={"Accept": "text/html"}),
            timeout=30)
        html = r.read().decode("utf-8", "ignore")
        print("    /home %s  triage.js=%s" % (r.status, "triage.js" in html))
    except urllib.error.HTTPError as e:
        print("    /home HTTP %d" % e.code)
    except Exception as e:
        print("    /home %s" % e)

    print("\n" + "=" * 54)
    print("RESULT")
    print("=" * 54)
    print("  Server  : http://localhost:%d/home" % PORT)
    print("  HTTPS   : https://localhost:%d/home" % HTTPS_PORT)
    print("  PID     : %d" % proc.pid)
    if proc2 is not None:
        print("  HTTPS P : %d" % proc2.pid)
    print("  Log     : server.log")
    print("  Doctor  : doctor@test.com / doctor123")


if __name__ == "__main__":
    main()
