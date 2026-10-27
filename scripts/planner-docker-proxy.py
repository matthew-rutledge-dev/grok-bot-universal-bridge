#!/usr/bin/env python3
"""Host-side TCP proxy: docker network gateway(s):PORT -> 127.0.0.1:PORT.

Lets the bridge container reach a planner listener that only binds the host's
loopback (for example the end of a reverse tunnel). Ported from the older Discord
bridge's bin/planner-docker-proxy.py; the network name is now an argument, because
the compose project (and so its default network) changes at cutover.

  python3 scripts/planner-docker-proxy.py --network <compose-project>_default [--port 18771]

Binds the gateway of that network and of Docker's default "bridge" network. No
addresses are hard-coded. Plain TCP pass-through: auth stays on the planner request.
"""
import argparse
import socket
import subprocess
import threading
import time


def gateway(network: str) -> str:
    out = subprocess.check_output(
        ["docker", "network", "inspect", network, "--format", "{{range .IPAM.Config}}{{.Gateway}}{{end}}"],
        text=True,
    ).strip()
    if not out:
        raise RuntimeError(f"no gateway for network {network}")
    return out


def pipe(src: socket.socket, dst: socket.socket) -> None:
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            dst.sendall(data)
    except Exception:
        pass
    finally:
        try:
            dst.shutdown(socket.SHUT_WR)
        except Exception:
            pass


def handle(client: socket.socket, port: int) -> None:
    try:
        upstream = socket.create_connection(("127.0.0.1", port), 10)
    except Exception:
        client.close()
        return
    threading.Thread(target=pipe, args=(client, upstream), daemon=True).start()
    pipe(upstream, client)


def listen_one(addr: str, port: int) -> None:
    while True:
        srv = None
        try:
            srv = socket.socket()
            srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            srv.bind((addr, port))
            srv.listen(32)
            print(f"proxy listening {addr}:{port} -> loopback:{port}", flush=True)
            while True:
                client, _peer = srv.accept()
                threading.Thread(target=handle, args=(client, port), daemon=True).start()
        except Exception as exc:
            print(f"proxy retry {addr} {exc}", flush=True)
            if srv is not None:
                try:
                    srv.close()
                except Exception:
                    pass
            time.sleep(2)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--network", required=True, help="compose network of the bridge container, e.g. <project>_default")
    ap.add_argument("--port", type=int, default=18771)
    a = ap.parse_args()
    addrs = []
    for net in (a.network, "bridge"):
        try:
            gw = gateway(net)
            if gw not in addrs:
                addrs.append(gw)
        except Exception as exc:
            print(f"gateway lookup {net}: {exc}", flush=True)
    if not addrs:
        raise SystemExit("no docker gateway found")
    threads = [threading.Thread(target=listen_one, args=(x, a.port), daemon=True) for x in addrs]
    for t in threads:
        t.start()
    for t in threads:
        t.join()


if __name__ == "__main__":
    main()
