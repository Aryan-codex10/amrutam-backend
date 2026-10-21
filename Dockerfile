FROM node:22-slim AS build
WORKDIR /app
COPY backend/package.json backend/package-lock.json ./backend/
RUN npm ci --prefix backend
COPY backend ./backend
COPY database ./database
COPY api ./api
RUN npm --prefix backend run build

FROM node:22-slim AS runtime
ENV NODE_ENV=production PORT=8000
WORKDIR /app
COPY backend/package.json backend/package-lock.json ./backend/
RUN npm ci --prefix backend --omit=dev && npm cache clean --force
COPY --from=build /app/backend/dist ./backend/dist
COPY database ./database
COPY api ./api
USER node
EXPOSE 8000
CMD ["node", "backend/dist/src/server.js"]
