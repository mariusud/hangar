FROM node:22-slim
ENV DEVICEPOOL_HOME=/data NODE_ENV=production
WORKDIR /devicepool
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
COPY e2e/package.json ./e2e/
COPY bench/package.json ./bench/
RUN pnpm install --prod --frozen-lockfile --filter devicepool... \
  && printf '#!/bin/sh\nexec node --disable-warning=ExperimentalWarning /devicepool/packages/devicepool/src/main.ts "$@"\n' > /usr/local/bin/devicepool \
  && chmod +x /usr/local/bin/devicepool
RUN mkdir /data && chown node /data
VOLUME /data
EXPOSE 7420
USER node
CMD ["sh", "-c", "exec devicepool broker --host 0.0.0.0 ${DEVICEPOOL_URL:+--url $DEVICEPOOL_URL}"]
