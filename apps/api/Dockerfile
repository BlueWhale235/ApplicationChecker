FROM node:22-bookworm-slim AS build
WORKDIR /workspace
ARG DEBIAN_MIRROR=http://mirrors.aliyun.com
RUN sed -i "s|http://deb.debian.org|${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY packages/cookie-state/package.json ./packages/cookie-state/package.json
COPY packages/ai-status/package.json ./packages/ai-status/package.json
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
RUN pnpm install --filter @application-checker/api... --filter @application-checker/web... --frozen-lockfile=false
COPY packages ./packages
COPY apps/api ./apps/api
COPY apps/web ./apps/web
RUN pnpm --filter @application-checker/api... build
RUN pnpm --filter @application-checker/web... build

FROM node:22-bookworm-slim
ENV NODE_ENV=production WEB_HOST=0.0.0.0 WEB_PORT=8080 DATA_PATH=/data WEB_DIST_PATH=/workspace/apps/web/dist
WORKDIR /workspace
COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/packages ./packages
COPY --from=build /workspace/apps/api/dist ./apps/api/dist
COPY --from=build /workspace/apps/api/package.json ./apps/api/package.json
COPY --from=build /workspace/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /workspace/apps/web/dist ./apps/web/dist
EXPOSE 8080
CMD ["node", "apps/api/dist/server.js"]
