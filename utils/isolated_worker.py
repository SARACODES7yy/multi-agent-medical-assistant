"""Crash-proof worker for heavy native inference (RapidOCR / docling).

Render's 512MB instances get OOM-killed (or segfault) inside onnxruntime
inference, which takes the whole web server down and surfaces as HTTP 502.
Running that work in a short-lived child process means a crash only kills
the child: the parent sees a failed result and falls back gracefully
(vision LLM / friendly error) while the server keeps answering /health.

Parent side:  run_isolated("ocr", [path]) -> {"texts": [...]} | None
              run_isolated("pdf", [path]) -> {"text": str, "pages": int} | None
Worker side:  python -m utils.isolated_worker ocr <path>
              python -m utils.isolated_worker pdf <path>
"""

import json
import os
import subprocess
import sys


def run_isolated(task, args, timeout):
    """Run one worker task in a child process. Never raises; None = failed."""
    cmd = [sys.executable, "-m", "utils.isolated_worker", task, *[str(a) for a in args]]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        print(f"[isolated_worker] task '{task}' timed out after {timeout}s")
        return None
    except Exception as e:
        print(f"[isolated_worker] could not start task '{task}': {e}")
        return None
    if proc.returncode != 0:
        tail = (proc.stderr or "").strip().splitlines()[-3:]
        print(f"[isolated_worker] task '{task}' failed (exit {proc.returncode}): {' | '.join(tail)}")
        return None
    try:
        return json.loads(proc.stdout.strip().splitlines()[-1])
    except Exception as e:
        print(f"[isolated_worker] task '{task}' returned bad output: {e}")
        return None


def _worker_ocr(path):
    from rapidocr import RapidOCR
    engine = RapidOCR()
    result = engine(path)
    txts = (result.txts if result is not None else None) or []
    texts = [t if isinstance(t, str) else t[0] for t in txts]
    return {"texts": texts}


def _worker_pdf(path):
    from utils.pdf_extract import _convert_pdf_inproc
    text, pages = _convert_pdf_inproc(path)
    return {"text": text, "pages": pages}


def main(argv):
    if len(argv) < 3:
        print(json.dumps({"error": "usage: isolated_worker <ocr|pdf> <path>"}))
        return 2
    task, path = argv[1], argv[2]
    if not os.path.exists(path):
        print(json.dumps({"error": f"file not found: {path}"}))
        return 2
    try:
        if task == "ocr":
            out = _worker_ocr(path)
        elif task == "pdf":
            out = _worker_pdf(path)
        else:
            print(json.dumps({"error": f"unknown task: {task}"}))
            return 2
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        return 1
    if isinstance(out, dict) and out.get("error"):
        print(json.dumps(out))
        return 1
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
