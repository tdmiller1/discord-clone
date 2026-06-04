# syntax=docker/dockerfile:1

# --- build stage: compile native deps + TypeScript to dist/ ---
FROM node:24-bookworm-slim AS build
WORKDIR /app
# better-sqlite3 has no prebuilt binary for this Node ABI, so node-gyp must
# compile it from source — which needs Python + a C/C++ toolchain. These live
# only in the build stage; the runtime image below copies the compiled output.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
# Drop devDependencies (tsc/tsx/@types) but keep the compiled native modules.
RUN npm prune --omit=dev

# --- runtime stage: prod deps + compiled output only, no toolchain ---
FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HTTP_PORT=8080 \
    DATA_DIR=/data
COPY package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.HTTP_PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
