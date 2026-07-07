# Build stage
# Using node:18-alpine to match all other frontend services in this project.
# node:20 was previously used here inconsistently.
FROM node:18-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci && npm cache clean --force

# Copy source code
COPY . .

# VITE_API_URL is resolved at runtime by src/config/api.js.
ARG VITE_API_URL=
ENV VITE_API_URL=$VITE_API_URL

# Build the app
RUN npm run build

# Production stage
FROM nginx:alpine

# Install curl for healthcheck (nginx:alpine does not include it)
RUN apk add --no-cache curl

# Copy built app from builder stage
COPY --from=builder /app/dist /usr/share/nginx/html

# Copy nginx config
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 5175

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:5175/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
