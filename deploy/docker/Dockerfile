FROM oven/bun:1.3.14 AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
RUN bun run --filter @tenet/dashboard build && bun run --filter @tenet/server build

FROM oven/bun:1.3.14-slim
WORKDIR /app
COPY --from=build --chown=bun:bun /app/apps/server/dist ./apps/server/dist
COPY --from=build --chown=bun:bun /app/apps/dashboard/dist/client ./apps/dashboard/dist/client
COPY --from=build --chown=bun:bun /app/packages/api/migrations ./packages/api/migrations
USER bun
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3002 TENET_ASSETS_DIR=apps/dashboard/dist/client
EXPOSE 3002
CMD ["bun", "apps/server/dist/index.js"]
