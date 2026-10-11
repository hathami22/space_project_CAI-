import shutil
from pathlib import Path


FRONTEND_DIR = Path(__file__).resolve().parent
DIST_DIR = FRONTEND_DIR / "dist"
NODE_MODULES = FRONTEND_DIR / "node_modules"


def build() -> None:
    react_runtime = NODE_MODULES / "react" / "umd" / "react.production.min.js"
    react_dom_runtime = (
        NODE_MODULES / "react-dom" / "umd" / "react-dom.production.min.js"
    )
    for runtime in (react_runtime, react_dom_runtime):
        if not runtime.is_file():
            raise FileNotFoundError(
                f"{runtime} is missing. Run npm.cmd install in {FRONTEND_DIR}."
            )

    if DIST_DIR.exists():
        shutil.rmtree(DIST_DIR)
    DIST_DIR.mkdir(parents=True)
    shutil.copy2(FRONTEND_DIR / "index.html", DIST_DIR / "index.html")
    shutil.copytree(FRONTEND_DIR / "src", DIST_DIR / "src")
    metrics_file = FRONTEND_DIR.parent / "tests" / "output" / "telemetry_metrics.json"
    if metrics_file.is_file():
        metrics_output = DIST_DIR / "tests" / "output"
        metrics_output.mkdir(parents=True, exist_ok=True)
        shutil.copy2(metrics_file, metrics_output / metrics_file.name)
    else:
        metrics_output = DIST_DIR / "tests" / "output"
        metrics_output.mkdir(parents=True, exist_ok=True)
        (metrics_output / "telemetry_metrics.json").write_text(
            "{}\n",
            encoding="utf-8",
        )

    vendor_dir = DIST_DIR / "vendor"
    vendor_dir.mkdir()
    shutil.copy2(react_runtime, vendor_dir / "react.production.min.js")
    shutil.copy2(react_dom_runtime, vendor_dir / "react-dom.production.min.js")

    index_file = DIST_DIR / "index.html"
    html = index_file.read_text(encoding="utf-8")
    html = html.replace(
        "/node_modules/react/umd/react.production.min.js",
        "/vendor/react.production.min.js",
    )
    html = html.replace(
        "/node_modules/react-dom/umd/react-dom.production.min.js",
        "/vendor/react-dom.production.min.js",
    )
    index_file.write_text(html, encoding="utf-8")

    print(f"Built offline dashboard assets in {DIST_DIR}")


if __name__ == "__main__":
    build()
