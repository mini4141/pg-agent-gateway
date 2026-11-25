# syntax=docker/dockerfile:1
FROM node:24.12-alpine AS build
RUN npm i -g pnpm@12.3.4
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY apps/gateway/package.json apps/gateway/
COPY apps/console/package.json apps/console/
COPY apps/mcp-server/package.json apps/mcp-server/
COPY tools/agent-sim/package.json tools/agent-sim/
COPY infra/package.json infra/
COPY tests/package.json tests/
RUN pnpm install --frozen-lockfile --filter gateway... --filter console...
COPY apps/gateway apps/gateway
COPY apps/console apps/console
RUN pnpm --filter gateway build && pnpm --filter console build
RUN pnpm --filter gateway deploy --prod /out

FROM build AS sim-build
RUN pnpm install --frozen-lockfile --filter agent-sim...
COPY tools/agent-sim tools/agent-sim
RUN pnpm --filter agent-sim deploy /sim

# Load generator, run on the compose network so Docker Desktop's port forwarding does not distort latency.
FROM node:24.12-alpine AS agent-sim
WORKDIR /sim
COPY --from=sim-build /sim .
ENTRYPOINT ["node_modules/.bin/tsx", "src/cli.ts"]

FROM node:24.12-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out/node_modules node_modules
COPY --from=build /out/package.json .
COPY --from=build /repo/apps/gateway/dist dist
COPY --from=build /repo/apps/console/dist public
COPY db db
USER node
EXPOSE 8080
CMD ["node", "dist/main.js"]
