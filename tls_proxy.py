#!/usr/bin/env python3
"""TLS reverse proxy: https://0.0.0.0:8443 -> http://127.0.0.1:8000.

Lets the browser see a secure context (needed for the Web Speech mic API)
while the app runs a single HTTP instance on :8000 (the app embeds a
Qdrant local storage store that allows only one app process at a time).
"""
import asyncio
import ssl

CERT = "certs/cert.pem"
KEY = "certs/key.pem"
LISTEN = ("0.0.0.0", 8443)
ORIGIN = ("127.0.0.1", 8000)


async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=5)
        first = head.split(b"\r\n", 1)[0].decode("latin-1")
        parts = first.split(" ", 2)
        if len(parts) < 2:
            return
        method, path = parts[0], parts[1]
        text = head.decode("latin-1")
        clen = 0
        orig_headers = []
        for line in text.split("\r\n")[1:]:
            if ":" not in line:
                continue
            k, v = line.split(":", 1)
            kk = k.strip(); vv = v.strip()
            if kk.lower() in ("connection", "transfer-encoding", "host"):
                continue
            if kk.lower() == "content-length":
                clen = int(vv)
                continue
            orig_headers.append((kk, vv))
        orig_headers.append(("Content-Length", str(clen)))
        orig_headers.append(("Connection", "close"))
        body = await asyncio.wait_for(reader.readexactly(clen), timeout=10) if clen else b""
        origin = await asyncio.open_connection(*ORIGIN)
        orr, orw = origin
        req = f"{method} {path} HTTP/1.1\r\nHost: {ORIGIN[0]}\r\n" + "\r\n".join(f"{k}: {v}" for k, v in orig_headers) + "\r\n\r\n"
        req = req.encode("latin-1") + body
        orw.write(req)
        await orw.drain()
        rdata = await asyncio.wait_for(orr.read(), timeout=30)
        writer.write(rdata)
        await writer.drain()
    except Exception:
        pass
    finally:
        try:
            writer.close()
            await writer.wait_closed()
        except Exception:
            pass


async def main() -> None:
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(CERT, KEY)
    srv = await asyncio.start_server(handle, *LISTEN, ssl=ctx)
    async with srv:
        print(f"TLS proxy ready: https://{LISTEN[0]}:{LISTEN[1]} -> http://{ORIGIN[0]}:{ORIGIN[1]}")
        await srv.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())