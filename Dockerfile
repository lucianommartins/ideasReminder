# Use an official Node.js runtime as a parent image
FROM node:20-slim

# Update packages to the latest version to patch vulnerabilities.
RUN apt-get update && apt-get upgrade -y --no-install-recommends && rm -rf /var/lib/apt/lists/*

# Set the working directory in the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json.
# The build context is the project root, so these paths are correct.
COPY package*.json ./

# Install ALL dependencies (including devDependencies) needed for the build
RUN npm install

# Copy the source code and typescript configuration
COPY tsconfig.json ./
COPY src/ ./src/

# Build the TypeScript code to JavaScript && prune devDependencies
RUN npm run build && npm prune --production

# The main application listens on port 3000
EXPOSE 3000

# Define the command to run the application
CMD [ "node", "dist/index.js" ] 