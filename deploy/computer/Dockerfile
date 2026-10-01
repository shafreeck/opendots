# Official Node image, explicit version. Resolve to a reviewed digest before release.
ARG NODE_IMAGE=node:24.21.0-bookworm-slim
FROM ${NODE_IMAGE} AS native-helper
RUN apt-get update && apt-get install -y --no-install-recommends build-essential pkg-config libx11-dev libxtst-dev libxi-dev libpng-dev
COPY native/linux-desktop /build
RUN make -C /build

FROM ${NODE_IMAGE}
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates chromium chromium-sandbox xvfb x11-utils x11vnc openbox \
    dbus-x11 xauth socat tini util-linux fonts-liberation fonts-noto-cjk libx11-6 libxtst6 libxi6 libpng16-16 \
 && dpkg-query -W > /usr/local/share/opendots-os-packages.txt \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/opendots
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=native-helper /build/opendots-linux-desktop /usr/local/libexec/opendots-linux-desktop
COPY src ./src
COPY public ./public
COPY scripts/prepare-container-computer-config.mjs ./scripts/prepare-container-computer-config.mjs
COPY vendor ./vendor
COPY licenses ./licenses
COPY NOTICE THIRD_PARTY_NOTICES.md ./
COPY deploy/computer/start.sh deploy/computer/healthcheck.sh /usr/local/bin/
RUN chmod 0555 /usr/local/bin/start.sh /usr/local/bin/healthcheck.sh \
 && mkdir -p /state /home/node/browser /home/node/Downloads \
 && chown node:node /state /home/node/browser /home/node/Downloads
ENV HOME=/home/node DISPLAY=:99 XAUTHORITY=/tmp/opendots.Xauthority \
    XDG_RUNTIME_DIR=/tmp/opendots-runtime PORT=3210 \
    OPENDOTS_DB_PATH=/state/opendots.sqlite OPENDOTS_MODE=runtime \
    OPENDOTS_COMPUTER_ENABLED=1 OPENDOTS_VNC_PREVIEW_READ_ONLY=1 \
    OPENDOTS_VNC_PREVIEW_PORT=5901 OPENDOTS_VNC_CONTROL_PORT=5902
USER node
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/start.sh"]
HEALTHCHECK --interval=20s --timeout=5s --start-period=40s --retries=3 CMD ["/usr/local/bin/healthcheck.sh"]
