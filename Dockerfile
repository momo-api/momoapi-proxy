FROM node:24-alpine
WORKDIR /app
COPY package.json ./
COPY bin ./bin
COPY src ./src
COPY test ./test
COPY scripts/compact-fixtures.mjs ./scripts/compact-fixtures.mjs
COPY .agents ./.agents
COPY plugins ./plugins
RUN node --test
CMD ["node", "--test"]
