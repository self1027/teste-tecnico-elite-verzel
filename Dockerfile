FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json drizzle.config.js ./
COPY src ./src
COPY drizzle ./drizzle

USER node
CMD ["npm", "run", "db:seed"]
