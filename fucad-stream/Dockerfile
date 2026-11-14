# syntax=docker/dockerfile:1
#
# FuCad desktop application, built unchanged from D:\devo\FuCad and streamed to the browser.
# Build context is the FuCad source folder (see docker-compose.yml); nothing in it is modified on disk.
#
# The base image runs a Selkies web desktop and serves its client on port 3000 (the same base as
# lscr.io/linuxserver/freecad); the portal's FreeCAD page shows that client in an iframe.

FROM lscr.io/linuxserver/baseimage-selkies:debianbookworm

ARG PIXI_VERSION=v0.49.0
# Parallel compile jobs. FuCad's larger files need ~1 GB of RAM each; keep jobs <= RAM in GB - 2.
ARG BUILD_JOBS=6

ENV TITLE=FuCad \
    PIXI_HOME=/opt/pixi \
    PIXI_CACHE_DIR=/tmp/pixi-cache \
    PATH=/opt/pixi/bin:$PATH

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# OpenGL (Mesa software rendering) and fonts for the Qt 6 / Coin3D viewer, plus pixi.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl \
      libgl1 libglx-mesa0 libgl1-mesa-dri libegl1 libglu1-mesa \
      libxkbcommon-x11-0 libxcb-cursor0 libxcb-icccm4 libxcb-keysyms1 libxcb-image0 \
      libxcb-render-util0 libxcb-xinerama0 libxcb-randr0 libxcb-shape0 libxcb-xkb1 \
      fonts-dejavu fonts-liberation \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL https://pixi.sh/install.sh | PIXI_VERSION="${PIXI_VERSION}" PIXI_NO_PATH_UPDATE=1 bash

COPY . /opt/fucad-src
WORKDIR /opt/fucad-src

# One layer so the build tree and download cache never end up in the image.
#  1. The Windows checkout has CRLF line endings; convert text files to LF for the Linux build.
#  2. Install the exact dependency set from pixi.lock (conda-forge).
#  3. Configure, build and install with FuCad's own "conda-linux-release" CMake preset.
#  4. Save the environment activation so the desktop can start FuCad without pixi.
RUN grep -rIlZ $'\r' . | xargs -0 -r sed -i 's/\r$//' \
 && pixi install --frozen \
 && pixi run --frozen cmake --preset conda-linux-release \
 && pixi run --frozen cmake --build build/release --parallel "${BUILD_JOBS}" \
 && pixi run --frozen cmake --install build/release \
 && pixi shell-hook --frozen > /opt/fucad-env.sh \
 && rm -rf build "${PIXI_CACHE_DIR}" \
 && test -x .pixi/envs/default/bin/FuCad

# Folder that docker-compose.yml maps to a folder on the host PC. Save / Save As open here, so
# saved designs land on the PC and not only inside the container.
ENV FUCAD_SAVE_DIR=/config/FuCad-Files \
    FUCAD_FILES_PORT=3001

# Read-only download service for the portal's "Downloads" button: lists the files in
# FUCAD_SAVE_DIR and serves each one as a download. It never writes or deletes anything.
#   GET /list               -> [{"path", "size", "modified"}], newest first
#   GET /file?path=<path>   -> the file, as an attachment
COPY --chmod=755 <<'EOF' /usr/local/bin/fucad-files
#!/usr/bin/env python3
import json, os, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, urlparse

ROOT = os.path.realpath(os.environ.get("FUCAD_SAVE_DIR", "/config/FuCad-Files"))
PORT = int(os.environ.get("FUCAD_FILES_PORT", "3001"))


def list_files():
    files = []
    for folder, dirs, names in os.walk(ROOT):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for name in names:
            if name.startswith("."):
                continue
            full = os.path.join(folder, name)
            try:
                st = os.stat(full)
            except OSError:
                continue
            files.append({
                "path": os.path.relpath(full, ROOT).replace(os.sep, "/"),
                "size": st.st_size,
                "modified": int(st.st_mtime * 1000),
            })
    files.sort(key=lambda f: f["modified"], reverse=True)
    return files


def resolve(rel):
    # Only regular files inside ROOT; "..", absolute paths and symlinks out of ROOT are refused.
    full = os.path.realpath(os.path.join(ROOT, rel))
    if os.path.commonpath([full, ROOT]) != ROOT or not os.path.isfile(full):
        return None
    return full


class Handler(BaseHTTPRequestHandler):
    def cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Expose-Headers", "Content-Disposition")

    def fail(self, code, message):
        body = json.dumps({"error": message}).encode()
        self.send_response(code)
        self.cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.end_headers()

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/list":
            body = json.dumps(list_files()).encode()
            self.send_response(200)
            self.cors()
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif url.path == "/file":
            rel = parse_qs(url.query).get("path", [""])[0]
            full = resolve(rel) if rel else None
            if full is None:
                return self.fail(404, "File not found")
            name = os.path.basename(full)
            self.send_response(200)
            self.cors()
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Disposition", "attachment; filename*=UTF-8''" + quote(name))
            self.send_header("Content-Length", str(os.path.getsize(full)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            with open(full, "rb") as f:
                while chunk := f.read(65536):
                    self.wfile.write(chunk)
        else:
            self.fail(404, "Not found")

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    os.makedirs(ROOT, exist_ok=True)
    try:
        server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    except OSError:
        sys.exit(0)  # already running (FuCad was restarted inside the same session)
    server.serve_forever()
EOF

# Start FuCad as the only application on the streamed desktop.
COPY --chmod=755 <<'EOF' /usr/local/bin/start-fucad
#!/bin/bash
source /opt/fucad-env.sh
export LIBGL_ALWAYS_SOFTWARE=1

# Point FuCad's file dialogs at the host-mapped folder on every start (FuCad otherwise reopens the
# last folder used). The setting is "FileOpenSavePath" in FuCad's user.cfg.
mkdir -p "$FUCAD_SAVE_DIR"
python - "${XDG_CONFIG_HOME:-$HOME/.config}/FuCad/user.cfg" "$FUCAD_SAVE_DIR" <<'PY' || true
import os, sys
import xml.etree.ElementTree as ET

cfg, folder = sys.argv[1], sys.argv[2]
if os.path.exists(cfg):
    try:
        tree = ET.parse(cfg)
    except ET.ParseError:
        sys.exit(0)  # never overwrite a settings file we cannot read
else:
    tree = ET.ElementTree(ET.Element("FCParameters"))

node = tree.getroot()
for name in ("Root", "BaseApp", "Preferences", "General"):
    child = next((c for c in node.findall("FCParamGroup") if c.get("Name") == name), None)
    node = child if child is not None else ET.SubElement(node, "FCParamGroup", Name=name)

entry = next((c for c in node.findall("FCText") if c.get("Name") == "FileOpenSavePath"), None)
if entry is None:
    entry = ET.SubElement(node, "FCText", Name="FileOpenSavePath")
entry.text = folder

os.makedirs(os.path.dirname(cfg), exist_ok=True)
tree.write(cfg, encoding="utf-8", xml_declaration=True)
PY

# Download service for the portal's "Downloads" button (exits at once if it is already running).
python /usr/local/bin/fucad-files >/dev/null 2>&1 &

# The desktop runs Wayland with XWayland; prefer native Wayland, fall back to X11.
export QT_QPA_PLATFORM="${QT_QPA_PLATFORM:-wayland;xcb}"
cd "$HOME"
exec FuCad "$@"
EOF

RUN echo '/usr/local/bin/start-fucad' > /defaults/autostart

EXPOSE 3000 3001
