FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production && npm cache clean --force

# Copy application source code only.
# .env.example is NOT copied — configuration must be injected at runtime
# via environment variables (docker-compose env_file or Kubernetes Secrets).
# Baking .env files into images is a security anti-pattern.
COPY src ./src

EXPOSE 9100

# Health check via the metrics server
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -qO- http://127.0.0.1:9100/health || exit 1

# Run the service
CMD ["node", "src/index.js"]
