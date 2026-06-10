FROM node:20-bookworm

# Install FFmpeg + all native deps for canvas + fonts
RUN apt-get update && apt-get install -y \
    ffmpeg \
    build-essential \
    libcairo2-dev \
    libjpeg-dev \
    libpango1.0-dev \
    libgif-dev \
    librsvg2-dev \
    libpixman-1-dev \
    libpng-dev \
    libfreetype-dev \
    libfontconfig1-dev \
    pkg-config \
    fonts-noto \
    fonts-noto-cjk \
    fonts-noto-cjk-extra \
    fonts-dejavu-core \
    fonts-freefont-ttf \
    fonts-liberation \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files first for caching
COPY package.json package-lock.json* ./

# Install deps (rebuild native modules)
RUN npm install --build-from-source 2>&1 || npm install 2>&1

# Copy all source
COPY . .

# Create data dir for SQLite
RUN mkdir -p /app/data

# Expose port (Railway sets PORT env var)
EXPOSE 3000

# Healthcheck
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD curl -sf http://localhost:${PORT:-3000}/api/state || exit 1

CMD ["node", "all-in-one.js"]
