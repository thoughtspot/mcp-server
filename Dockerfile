# Use Node.js 20 LTS as the base image
FROM node:20-alpine AS base

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies
RUN npm ci

COPY . .

# Set default port
ENV PORT=3000

# Expose port
EXPOSE $PORT

# Health check
HEALTHCHECK --interval=60s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get(`http://localhost:${process.env.PORT || 3000}/mcp`, (res) => { process.exit(res.statusCode === 400 ? 0 : 1) })"

# Start the application
CMD ["npm", "run", "run:deploy"]
