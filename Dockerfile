FROM node:22-slim
ENV HANGAR_HOME=/data NODE_ENV=production
WORKDIR /hangar
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
COPY e2e/package.json ./e2e/
COPY bench/package.json ./bench/
RUN pnpm install --prod --frozen-lockfile --filter hangar... \
  && printf '#!/bin/sh\nexec node --disable-warning=ExperimentalWarning /hangar/packages/hangar/src/main.ts "$@"\n' > /usr/local/bin/hangar \
  && chmod +x /usr/local/bin/hangar
RUN mkdir /data && chown node /data
VOLUME /data
EXPOSE 7420
USER node
CMD ["sh", "-c", "exec hangar broker --host 0.0.0.0 ${HANGAR_URL:+--url $HANGAR_URL}"]
