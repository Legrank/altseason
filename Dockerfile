FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json

RUN npm ci

COPY backend backend
COPY frontend frontend

RUN npm run build --workspace backend && npm run build --workspace frontend

FROM node:22-bookworm-slim AS backend

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
RUN npm ci --omit=dev --workspace backend --include-workspace-root=false

COPY --from=build /app/backend/dist backend/dist

WORKDIR /app/backend
EXPOSE 3001

CMD ["node", "--experimental-sqlite", "dist/server.js"]

FROM nginx:1.27-alpine AS frontend

COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/frontend/dist /usr/share/nginx/html

EXPOSE 80
