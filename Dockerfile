FROM node:24-alpine
WORKDIR /app
COPY package.json ./
COPY install.sh ./install.sh
COPY bin ./bin
COPY src ./src
COPY test ./test
COPY scripts/compact-fixtures.mjs ./scripts/compact-fixtures.mjs
COPY scripts/build-release-package.mjs ./scripts/build-release-package.mjs
COPY .agents ./.agents
COPY plugins ./plugins
RUN node --test --test-concurrency=4 --test-timeout=60000
CMD ["node", "--test", "--test-concurrency=4", "--test-timeout=60000"]
