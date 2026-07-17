# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --only=production

# Production stage
FROM node:18-alpine

# Install mongodb-tools for mongodump
RUN apk add --no-cache mongodb-tools

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

# Create tmp directory for backups
RUN mkdir -p /tmp

EXPOSE 9200

USER node

CMD ["node", "src/index.js"]
