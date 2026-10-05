FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production HEADLESS=1 API_HOST=0.0.0.0 DATA_DIR=/data
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY policy ./policy
COPY web ./web
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 8787
CMD ["node", "dist/daemon.js"]
