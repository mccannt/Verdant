FROM node:20-alpine AS build
WORKDIR /app

COPY package.json tsconfig.base.json ./
COPY apps/ui/package.json apps/ui/
COPY apps/runner/package.json apps/runner/
COPY packages/llm/package.json packages/llm/
COPY packages/survey-engine/package.json packages/survey-engine/

RUN npm install

COPY . .
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8787

COPY --from=build /app /app
RUN npm prune --omit=dev

EXPOSE 8787
CMD ["npm", "run", "start"]
