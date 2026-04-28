# Bun-native single-stage image. The codebase is TypeScript run directly by
# Bun (no build step), so we just install deps + ship src/ + prompts/ + the
# bundled web assets. Persistent state lives outside the image at $DATA_DIR
# (Fly volume mount).
FROM oven/bun:1.3-alpine

WORKDIR /app

# Install deps first so the layer caches across code-only changes.
COPY package.json bunfig.toml ./
COPY bun.lock* ./
RUN bun install --frozen-lockfile || bun install

# Application code + assets the runtime reads from disk at request time.
COPY src ./src
COPY prompts ./prompts
COPY config.yaml ./config.yaml
COPY tsconfig.json ./tsconfig.json

# Default; override at deploy time.
ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV PORT=3456

# The volume is created on the Fly side; this just hints at the mount point.
VOLUME ["/data"]
EXPOSE 3456

CMD ["bun", "run", "src/index.ts"]
