FROM ubuntu:24.04 AS base

# Disable the runtime transpiler cache by default inside Docker containers.
# On ephemeral containers, the cache is not useful
ARG BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
ARG PLAYWRIGHT_MCP_VERSION=0.0.68
ENV BUN_RUNTIME_TRANSPILER_CACHE_PATH=${BUN_RUNTIME_TRANSPILER_CACHE_PATH}
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Disable Chromium crash handler in container environment
ENV CRASHPAD_HANDLER_PATH=/dev/null
ENV CHROME_BREAKPAD_ENABLED=0
ENV GOOGLE_BREAKPAD=0

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
    libatspi2.0-0 \
    fonts-liberation \
  && rm -rf /var/lib/apt/lists/*
# Install Playwright MCP and Chromium browser.
# MCP server defaults to looking for 'chrome' at /opt/google/chrome/chrome,
# so we symlink the installed chromium binary there.
RUN npm install -g @playwright/mcp@${PLAYWRIGHT_MCP_VERSION} \
  && PLAYWRIGHT_BROWSERS_PATH=/ms-playwright node /usr/local/lib/node_modules/@playwright/mcp/node_modules/playwright/cli.js install --with-deps chromium \
  && mkdir -p /opt/google/chrome \
  && ln -s /ms-playwright/chromium-*/chrome-linux/chrome /opt/google/chrome/chrome

# Run opencode as an unprivileged user by default.
RUN useradd -m -s /bin/bash opencode \
  && install -d -m 755 -o opencode -g opencode /workspace /home/opencode/.config/opencode /home/opencode/.cache/opencode /home/opencode/.local/share/opencode /home/opencode/.local/state/opencode \
  && chown -R opencode:opencode /ms-playwright \
  && chmod -R 755 /ms-playwright
ENV HOME=/home/opencode
ENV OPENCODE_CONFIG_DIR=/.opencode

FROM base AS build-amd64
COPY dist/opencode-linux-x64-baseline/bin/opencode /usr/local/bin/opencode

FROM base AS build-arm64
COPY dist/opencode-linux-arm64/bin/opencode /usr/local/bin/opencode

ARG TARGETARCH
FROM build-${TARGETARCH}
USER opencode
RUN opencode --version
ENTRYPOINT ["opencode"]
