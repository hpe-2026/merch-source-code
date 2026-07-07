# Build stage
FROM node:18-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci && npm cache clean --force

COPY . .

# VITE_API_URL is resolved at runtime by src/config/api.js.
# Do NOT set it here — leave it empty so the SPA detects the API from the browser URL.
ARG VITE_API_URL=
ENV VITE_API_URL=$VITE_API_URL

RUN npm run build

# Production stage
FROM nginx:alpine

RUN apk add --no-cache curl

# Copy built app from builder stage
COPY --from=builder /app/dist /usr/share/nginx/html

# Copy nginx config
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 5174

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:5174/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
