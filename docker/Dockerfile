# 构建阶段保留工具链；最终镜像不携带测试、真实账单或环境变量。
FROM node:22-bookworm-slim AS build
WORKDIR /workspace
RUN npm install --global pnpm@12.5.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @bookkeepx/web build
RUN pnpm --filter @bookkeepx/server deploy --legacy --prod /runtime

FROM node:22-bookworm-slim AS server
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /runtime ./
USER node
EXPOSE 3000
CMD ["node", "node_modules/tsx/dist/cli.mjs", "src/main.ts"]

FROM nginx:stable-alpine AS web
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /workspace/apps/web/dist /usr/share/nginx/html
COPY --from=build /workspace/apps/web/dist/assets /opt/bookkeepx-assets
COPY --chmod=755 docker/40-preserve-assets.sh /docker-entrypoint.d/40-preserve-assets.sh
EXPOSE 80
