# OS_Planner server + website in one image: the API, the built Angular app and /downloads, plus Chromium for PDF export.
#   docker build -t os-planner .
#   docker compose --profile prod up -d        (see README: needs a .env with secrets)

# ---------------------------------------------------------------- build
FROM node:24-bookworm-slim AS build
WORKDIR /repo

# Dependencies first, so source edits do not reinstall them. Every workspace manifest is needed to resolve the lockfile.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/desktop/package.json apps/desktop/
# Scripts are skipped on purpose: electron (desktop) must not download its binary here, and the native
# modules the server needs (argon2, sharp) ship prebuilt binaries.
RUN npm ci --ignore-scripts --no-audit --no-fund

COPY . .
# Where the website sends its API calls. Empty (the default) = the same origin that serves the site. The build is not
# interactive, so this is the only way to set it here:  docker build --build-arg OS_PLANNER_API_URL=https://api.example.com .
# It lands in the site's config.json, which can also be edited later in the running image.
ARG OS_PLANNER_API_URL=""
ENV OS_PLANNER_API_URL=$OS_PLANNER_API_URL
# `prisma generate` never connects, but prisma.config.ts insists on a DATABASE_URL, so give it a placeholder.
RUN npm run build -w @os-planner/shared \
 && DATABASE_URL=mysql://build:build@localhost:3306/build npm run prisma:generate -w @os-planner/server \
 && npm run build -w @os-planner/web \
 && npm run build -w @os-planner/server

# Keep only what the server needs at run time: no Angular, Electron or test tooling.
RUN npm prune --omit=dev --no-audit --no-fund \
 && rm -rf apps/desktop apps/web/node_modules/.cache

# ---------------------------------------------------------------- run
FROM node:24-bookworm-slim AS runtime
# Chromium renders PDFs. The fonts matter: without them accents and symbols come out as boxes.
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-liberation fonts-noto-core fonts-noto-color-emoji ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    CHROME_PATH=/usr/bin/chromium \
    PDF_NO_SANDBOX=true \
    WEB_DIST_DIR=/app/apps/web/dist/web/browser

WORKDIR /app
COPY --from=build --chown=node:node /repo /app
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 3000

# Healthy = the database, the storage folder and the realtime socket server answer (?strict=1); mail or Redis trouble is reported, not fatal.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://localhost:'+process.env.PORT+'/api/health?strict=1').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Apply database migrations, then start. (prisma.config.ts lives in apps/server.)
WORKDIR /app/apps/server
CMD ["sh", "-c", "node ../../node_modules/prisma/build/index.js migrate deploy && node dist/main.js"]
