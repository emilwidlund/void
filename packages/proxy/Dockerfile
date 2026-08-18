# The void proxy — a merchant-side billing sidecar.
#
# Build from the REPO ROOT (the workspace is the build context):
#
#   docker build -f packages/proxy/Dockerfile -t void-proxy .
#   docker run -p 4010:4010 \
#     -e VOID_UPSTREAM=https://billing.example.com \
#     -e VOID_TOKEN=... \
#     -v void-proxy-data:/data \
#     void-proxy
#
# The /data volume holds the event journal and cached config — with it, the
# proxy survives both its own restarts and upstream outages without losing a
# single billed event.

FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm exec turbo run build --filter=@void/proxy...
# `pnpm deploy` produces a standalone folder: dist + production deps, with
# the workspace packages (@void/server, @void/compiler) copied in.
RUN pnpm --filter @void/proxy deploy --prod --legacy /out

FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=4010 \
    VOID_PROXY_DATA=/data
WORKDIR /app
COPY --from=build /out .
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 4010
USER node
CMD ["node", "dist/main.js"]
