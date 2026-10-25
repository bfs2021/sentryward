FROM node:24-slim

# python3, make and g++ build re2 (a native addon) when no prebuilt binary
# matches this platform and Node version.
RUN apt-get update && apt-get install -y --no-install-recommends openssl python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

EXPOSE 4000
CMD ["sh", "-c", "npx prisma generate && npx prisma migrate deploy && npm run dev"]
