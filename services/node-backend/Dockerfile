# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies with legacy peer deps flag
RUN npm ci --legacy-peer-deps --ignore-optional --no-audit --no-fund && npm cache clean --force

# Production stage
FROM node:18-alpine

WORKDIR /app

# Create logs directory
RUN mkdir -p logs

# Install curl for health checks
RUN apk add --no-cache curl

# Copy from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy application files
COPY package*.json ./
COPY src ./src
COPY openapi ./openapi

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/api/health || exit 1

# Expose port
EXPOSE 3000

# NODE_ENV is intentionally NOT set here.
# It must be provided at runtime via the environment (docker-compose / Kubernetes Secret).
# The application will use 'production' semantics when NODE_ENV=production is passed in,
# which suppresses stack traces in API error responses.
# Default in config/index.js is 'development' for local safety.

# Start application
CMD ["node", "src/index.js"]
