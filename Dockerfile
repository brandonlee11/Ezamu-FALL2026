FROM node:22-slim
WORKDIR /app
COPY . .
# Recordings and the database live here. Mount a persistent disk/volume at /data.
ENV ALOUD_DATA=/data
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
