# --- Build Stage ---
# Use the Node.js 22 slim image, which contains all necessary build tools.
FROM node:22-slim AS build

# Update npm to the latest version to avoid version notices during the build
RUN npm install -g npm@latest

WORKDIR /usr/src/app

# Copy package files and install all dependencies (including dev)
COPY package*.json ./
RUN npm install

# Copy the rest of the source code and build the application
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Remove development dependencies to prepare for the production stage
RUN npm prune --production


# --- Production Stage ---
# Use a minimal "distroless" image. It contains only Node.js and the bare
# minimum packages needed to run the app, drastically reducing vulnerabilities.
FROM gcr.io/distroless/nodejs22-debian12

WORKDIR /usr/src/app

# Copy the built application and production dependencies from the build stage
COPY --from=build /usr/src/app/dist ./dist
COPY --from=build /usr/src/app/node_modules ./node_modules

# Expose the application port
EXPOSE 3000

# The distroless image's entrypoint is already 'node', so just specify the script.
CMD [ "dist/index.js" ] 