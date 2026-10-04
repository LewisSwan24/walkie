FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY bin ./bin
ENV NODE_ENV=production
USER node
EXPOSE 8080
CMD ["node", "bin/relay.js"]
