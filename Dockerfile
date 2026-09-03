FROM node:22.23.2-bookworm AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run typecheck && npm run build:css

FROM node:22.23.2-bookworm AS runtime

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/src ./src
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/public ./public

EXPOSE 8080

CMD ["./node_modules/.bin/tsx", "src/index.ts"]
