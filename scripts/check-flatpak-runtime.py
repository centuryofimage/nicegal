"""Check packaged native dependencies and backend startup against Platform, not SDK."""

import json
import secrets
import selectors
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.request import Request, urlopen

build = Path(sys.argv[1]).resolve()
app = build / "files/nicegal"
backend = app / "resources/nicegal-server/nicegal-server"
if not backend.is_file():
    raise SystemExit("Packaged backend is missing")

native_files = [app / "nicegal", backend, *app.rglob("*.so"), *app.rglob("*.so.*")]
for binary in dict.fromkeys(native_files):
    if binary.is_symlink():
        continue
    destination = "/app/nicegal/" + binary.relative_to(app).as_posix()
    result = subprocess.run(
        ["flatpak", "build", "--runtime", str(build), "ldd", destination],
        capture_output=True, text=True, check=True,
    )
    if "not found" in result.stdout:
        raise SystemExit(f"Missing runtime dependency for {destination}:\n{result.stdout}")
print("Packaged Electron, backend and ONNX libraries resolve against Platform")

with tempfile.TemporaryDirectory(prefix="nicegal-flatpak-smoke-") as state:
    token = secrets.token_hex(32)
    command = [
        "flatpak", "build", "--runtime", "--share=network",
        f"--env=NICEGAL_RPC_TOKEN={token}",
        f"--bind-mount=/tmp/nicegal-smoke={state}", str(build),
        "/app/nicegal/resources/nicegal-server/nicegal-server",
        "--asset-database", "/tmp/nicegal-smoke/assets.db",
        "--ocr-database", "/tmp/nicegal-smoke/ocr.db",
        "--thumbnail-database", "/tmp/nicegal-smoke/thumbnails.db",
    ]
    with tempfile.TemporaryFile(mode="w+") as errors:
        process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=errors, text=True)
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout, selectors.EVENT_READ)
                if not selector.select(timeout=20):
                    raise RuntimeError("Backend did not announce readiness within 20 seconds")
            ready = json.loads(process.stdout.readline())
            request = Request(ready["endpoint"] + "/v1/runtime",
                              headers={"Authorization": f"Bearer {token}"})
            with urlopen(request, timeout=20) as response:
                runtime = json.load(response)
            if not runtime.get("onnxRuntimeBuildInfo"):
                raise RuntimeError("ONNX runtime did not initialize")
            print("Backend starts and ONNX runtime initializes in Platform")
        except Exception:
            errors.seek(0)
            print(errors.read(), file=sys.stderr)
            raise
        finally:
            # The desktop's normal graceful shutdown protocol is stdin EOF.
            process.stdin.close()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
