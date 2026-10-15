# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS base
WORKDIR /app
ENV npm_config_update_notifier=false \
    npm_config_fund=false

# Copy only manifests first so dependency installation remains cacheable.
FROM base AS dependencies
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/mock-receiver/package.json apps/mock-receiver/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci

FROM dependencies AS builder
COPY . .
RUN npm run build

# Runtime dependencies are installed without root/workspace development tools.
# The builder is intentionally separate because TypeScript, Vite, tsx, and
# test tooling are not required by the API or worker at runtime.
FROM base AS production-dependencies
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/mock-receiver/package.json apps/mock-receiver/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci --omit=dev

FROM base AS api
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=production-dependencies /app/package.json ./package.json
COPY --from=production-dependencies /app/apps/api/package.json ./apps/api/package.json
COPY --from=builder /app/apps/api/dist ./apps/api/dist
EXPOSE 3000
USER node
CMD ["node", "apps/api/dist/server.js"]

FROM base AS worker
ENV NODE_ENV=production
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=production-dependencies /app/package.json ./package.json
COPY --from=production-dependencies /app/apps/worker/package.json ./apps/worker/package.json
COPY --from=builder /app/apps/worker/dist ./apps/worker/dist
USER node
CMD ["node", "apps/worker/dist/index.js"]

FROM base AS mock-receiver
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=production-dependencies /app/package.json ./package.json
COPY --from=production-dependencies /app/apps/mock-receiver/package.json ./apps/mock-receiver/package.json
COPY --from=builder /app/apps/mock-receiver/dist ./apps/mock-receiver/dist
EXPOSE 8080
USER node
CMD ["node", "apps/mock-receiver/dist/server.js"]

FROM builder AS migrate
ENV NODE_ENV=development
CMD ["npm", "run", "db:migrate"]

FROM nginx:1.27-alpine AS web
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
