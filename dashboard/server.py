import argparse
import mimetypes
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


FRONTEND_DIST = Path(__file__).resolve().parent / "frontend" / "dist"
mimetypes.add_type("text/javascript", ".jsx")


def main(host: str, port: int) -> None:
    if not (FRONTEND_DIST / "index.html").is_file():
        raise FileNotFoundError(
            f"Built frontend not found at {FRONTEND_DIST}. "
            "Run npm.cmd run build from dashboard\\frontend first."
        )

    handler = partial(
        SimpleHTTPRequestHandler,
        directory=str(FRONTEND_DIST),
    )
    with ThreadingHTTPServer((host, port), handler) as server:
        print(f"Built Mission Control frontend available at http://{host}:{port}")
        print("Static files are served from frontend\\dist; press Ctrl+C to stop.")
        server.serve_forever()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Serve the built C.R.A.T.E.R. frontend over HTTP"
    )
    parser.add_argument("--host", default="localhost")
    parser.add_argument("--port", type=int, default=8000)
    arguments = parser.parse_args()
    try:
        main(arguments.host, arguments.port)
    except KeyboardInterrupt:
        pass
