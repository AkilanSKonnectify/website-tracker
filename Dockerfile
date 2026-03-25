# Use an official Node runtime as the base image
FROM node:20-alpine

# Set working directory
WORKDIR /usr/src/app

# Copy package metadata and install dependencies first (layer caching)
COPY package.json package-lock.json* ./
RUN npm install --production

# Copy application code
COPY index.js ./

# Expose port (match app default 3000)
EXPOSE 3000

# Healthcheck optional
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:3000/ || exit 1

# Start the app
CMD ["node", "index.js"]
