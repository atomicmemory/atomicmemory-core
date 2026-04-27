FROM node:22-slim

WORKDIR /app

# Copy dependency manifests first for layer caching
COPY package.json package-lock.json ./

# Install production dependencies.
# --legacy-peer-deps: openai@4.x still declares a peerOptional on zod@^3,
# but the rest of the tree has moved to zod@^4. Host-side installs use
# npm's softer peer resolution by default; `npm ci` on node:22-slim is
# strict, so opt into legacy resolution here until openai publishes a
# zod@4-compatible release.
# HUSKY=0: the `prepare` script runs `husky`, which is a devDep omitted
# here. Husky v9 respects this env var and skips silently.
RUN HUSKY=0 npm ci --omit=dev --legacy-peer-deps

# Copy application source
COPY src/ ./src/
COPY tsconfig.json ./

# Create non-root user for security
RUN useradd --create-home appuser && chown -R appuser:appuser /app
USER appuser

# Railway injects PORT env var; default to 3050
ENV PORT=3050
EXPOSE ${PORT}

# Run migration then start server
# tsx runs TypeScript directly — no build step needed
# exec replaces sh so Node receives signals (SIGTERM) and exit codes propagate
CMD ["sh", "-c", "npx tsx src/db/migrate.ts && exec npx tsx src/server.ts"]
