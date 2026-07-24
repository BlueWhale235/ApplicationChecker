FROM node:24-bookworm-slim AS build
WORKDIR /workspace
RUN corepack enable
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY apps/runner/package.json ./apps/runner/package.json
RUN pnpm install --filter @application-checker/runner... --frozen-lockfile=false
COPY packages ./packages
COPY apps/runner ./apps/runner
RUN pnpm --filter @application-checker/runner... build

FROM node:24-bookworm-slim
ENV NODE_ENV=production DISPLAY=:99 BROWSER_BIN=/usr/bin/chromium
ARG DEBIAN_MIRROR=http://mirrors.aliyun.com
RUN sed -i "s|http://deb.debian.org|${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium xvfb x11vnc novnc websockify fonts-noto-cjk ca-certificates dumb-init \
    && rm -rf /var/lib/apt/lists/*
COPY apps/runner/novnc-overrides.css /usr/share/novnc/app/styles/application-checker.css
RUN sed -i '/<\/head>/i\    <link rel="stylesheet" href="app/styles/application-checker.css">' /usr/share/novnc/vnc.html
WORKDIR /workspace
COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/packages ./packages
COPY --from=build /workspace/apps/runner ./apps/runner
COPY apps/runner/docker-entrypoint.sh /usr/local/bin/application-checker-runner
RUN chmod +x /usr/local/bin/application-checker-runner
ENTRYPOINT ["dumb-init", "--"]
CMD ["application-checker-runner"]
