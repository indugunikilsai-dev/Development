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

# Portal bridge (bridge/, shared with Dockerfile.freecad): File > Open / Import / Save / Save As /
# Export in FuCad work with the files on the user's PC through the portal's FreeCAD page.
#   PORTAL_BRIDGE_DIR       folder FuCad and the file service talk through; setting it turns the bridge on
#   PORTAL_WORK_DIR         where open documents live in the container while they are being edited
#   PORTAL_FILES_PORT       the file service; 3000/3001 are the stream's own HTTP/HTTPS ports
#   PORTAL_ALLOWED_ORIGINS  comma-separated portal origins allowed to call the file service ("*" = any)
#   PORTAL_UPLOAD_MAX_MB    largest file the PC file picker may send
ENV PORTAL_BRIDGE_DIR=/config/.portal-bridge \
    PORTAL_WORK_DIR=/config/PortalFiles \
    PORTAL_FILES_PORT=3002 \
    PORTAL_ALLOWED_ORIGINS=* \
    PORTAL_UPLOAD_MAX_MB=200

# No Selkies sidebar / controls over the stream: the page shows FuCad only.
ENV SELKIES_UI_SHOW_SIDEBAR=false

# The stream draws FuCad's cursor itself instead of handing it to the browser as a CSS cursor:
# browsers drop larger cursor images (fullscreen with Windows display scaling), which left the
# cursor invisible in fullscreen.
ENV SELKIES_USE_BROWSER_CURSORS=false

# Only FuCad on the desktop: no terminal (foot) in the right-click menu or anywhere else, and
# FuCad is started again if it is ever closed.
ENV DISABLE_TERMINALS=true \
    RESTART_APP=true

# The bridge is a FuCad module; install it next to FuCad's own modules (the folder holding Part).
COPY --from=bridge PortalBridge /tmp/PortalBridge
COPY --from=bridge --chmod=755 portal-files /usr/local/bin/portal-files
COPY --from=bridge --chmod=755 svc-portal-files.run /etc/s6-overlay/s6-rc.d/svc-portal-files/run
RUN mod_dir="$(dirname "$(find /opt/fucad-src/.pixi/envs/default -type d -path '*/Mod/Part' -print -quit)")" \
 && test -d "$mod_dir" \
 && rm -rf "$mod_dir/PortalBridge" && mkdir -p "$mod_dir/PortalBridge" \
 && cp /tmp/PortalBridge/InitGui.py /tmp/PortalBridge/PortalBridgeGui.py "$mod_dir/PortalBridge/" \
 && rm -rf /tmp/PortalBridge \
 && sed -i 's/\r$//' /usr/local/bin/portal-files /etc/s6-overlay/s6-rc.d/svc-portal-files/run "$mod_dir"/PortalBridge/*.py \
 && echo longrun > /etc/s6-overlay/s6-rc.d/svc-portal-files/type \
 && mkdir -p /etc/s6-overlay/s6-rc.d/svc-portal-files/dependencies.d \
 && touch /etc/s6-overlay/s6-rc.d/svc-portal-files/dependencies.d/init-services \
          /etc/s6-overlay/s6-rc.d/user/contents.d/svc-portal-files

# Start FuCad as the only application on the streamed desktop.
COPY --chmod=755 <<'EOF' /usr/local/bin/start-fucad
#!/bin/bash
source /opt/fucad-env.sh
export LIBGL_ALWAYS_SOFTWARE=1

# The desktop runs Wayland with XWayland; prefer native Wayland, fall back to X11.
export QT_QPA_PLATFORM="${QT_QPA_PLATFORM:-wayland;xcb}"
cd "$HOME"
exec FuCad "$@"
EOF

RUN echo '/usr/local/bin/start-fucad' > /defaults/autostart

EXPOSE 3000 3001 3002
