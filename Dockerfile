# Build: npm run build && docker build -t agent .
# Run:   docker run --rm -p 8080:8080 -e OPENAI_API_KEY agent
# Native binary alternative: copy dist-release/agent-linux-x64 and CMD ["agent","serve"]
FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json ./
COPY dist ./dist
ENV AGENT_SERVE_HOST=0.0.0.0
EXPOSE 8080
CMD ["node", "dist/cli.js", "serve", "--host", "0.0.0.0", "--port", "8080"]
