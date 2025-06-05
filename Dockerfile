# Use Node.js 18 Alpine as base image
FROM node:18-alpine

# Install system dependencies
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    ffmpeg

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies with better error handling
RUN npm config set registry https://registry.npmjs.org/ && \
    npm cache clean --force && \
    npm install --verbose --no-audit --no-fund --no-optional --prefer-offline --no-package-lock --legacy-peer-deps

# Copy app source
COPY . .

# Create necessary directories
RUN mkdir -p downloads subtitles temp

# Expose port
EXPOSE 3000

# Start the app
CMD ["npm", "start"] 