FROM ubuntu:24.04 AS base

# Disable the runtime transpiler cache by default inside Docker containers.
# On ephemeral containers, the cache is not useful
ARG BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
ARG PLAYWRIGHT_MCP_VERSION=0.0.68
ENV BUN_RUNTIME_TRANSPILER_CACHE_PATH=${BUN_RUNTIME_TRANSPILER_CACHE_PATH}
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates \
    libstdc++6 \
    ripgrep \
    python3 \
    python3-pip \
    nodejs \
    npm \
    docker.io \
  && rm -rf /var/lib/apt/lists/*
# Install Playwright MCP and browsers using MCP's bundled Playwright version.
RUN npm install -g @playwright/mcp@${PLAYWRIGHT_MCP_VERSION} \
  && PLAYWRIGHT_BROWSERS_PATH=/ms-playwright node /usr/local/lib/node_modules/@playwright/mcp/node_modules/playwright/cli.js install --with-deps chromium

# Run opencode as the default container user (root).
RUN install -d -m 755 /workspace /root/.config/opencode /root/.cache/opencode /root/.local/share/opencode /root/.local/state/opencode
ENV HOME=/root
ENV OPENCODE_CONFIG_DIR=/.opencode

FROM base AS build-amd64
COPY dist/opencode-linux-x64-baseline/bin/opencode /usr/local/bin/opencode

FROM base AS build-arm64
COPY dist/opencode-linux-arm64/bin/opencode /usr/local/bin/opencode

ARG TARGETARCH
FROM build-${TARGETARCH}
RUN opencode --version
ENTRYPOINT ["opencode"]
