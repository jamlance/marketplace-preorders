# Multi-stage build for Pre-orders.
FROM node:20-alpine AS builder
WORKDIR /work
RUN apk add --no-cache git python3 make g++
RUN npm install -g pnpm@9
COPY package.json pnpm-workspace.yaml ./
COPY packages/core ./packages/core
COPY apps/preorders ./apps/preorders
RUN pnpm install --no-frozen-lockfile
WORKDIR /work/apps/preorders
RUN pnpm exec vite build

FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache git
COPY --from=builder /work/package.json /work/pnpm-workspace.yaml ./
COPY --from=builder /work/node_modules ./node_modules
COPY --from=builder /work/packages ./packages
COPY --from=builder /work/apps/preorders/package.json ./apps/preorders/package.json
COPY --from=builder /work/apps/preorders/node_modules ./apps/preorders/node_modules
COPY --from=builder /work/apps/preorders/dist ./apps/preorders/dist
COPY apps/preorders/server.js ./apps/preorders/server.js
EXPOSE 3000
ENV PORT=3000 HOST=0.0.0.0
WORKDIR /app/apps/preorders
CMD ["node", "server.js"]
