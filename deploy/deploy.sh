#!/bin/bash

# Exit immediately if a command exits with a non-zero status.
set -e

# --- Configuration ---
# Validate that both service name and region are provided as arguments
if [ "$#" -ne 2 ]; then
    echo "Usage: $0 <service-name> <region>"
    echo "Example: $0 voicetasks-service us-central1"
    exit 1
fi

SERVICE_NAME=$1
REGION=$2

# Get the Google Cloud Project ID from the gcloud config
PROJECT_ID=$(gcloud config get-value project)
if [ -z "$PROJECT_ID" ]; then
    echo "Error: Google Cloud project ID not found. Make sure you are authenticated with 'gcloud auth login' and have a project configured."
    exit 1
fi

# Define the repository name and the image name for Artifact Registry
REPO_NAME="${SERVICE_NAME}-repo"
# The context for the image name is now from the parent directory
IMAGE_NAME="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO_NAME}/${SERVICE_NAME}"

# --- Check for Artifact Registry Repository ---
echo "--- Checking for Artifact Registry repository [${REPO_NAME}] in region [${REGION}] ---"
if ! gcloud artifacts repositories describe ${REPO_NAME} --location=${REGION} >/dev/null 2>&1; then
    echo "Repository not found. Creating it..."
    gcloud artifacts repositories create ${REPO_NAME} \
        --repository-format=docker \
        --location=${REGION} \
        --description="Repository for VoiceTasks application images"
    echo "Repository [${REPO_NAME}] created successfully."
else
    echo "Repository [${REPO_NAME}] already exists."
fi

# --- Build with Cloud Build ---
# The build context is the current directory (.), and Cloud Build will automatically find the Dockerfile.
echo "--- Building image with Cloud Build: ${IMAGE_NAME} ---"
gcloud builds submit ../ --tag ${IMAGE_NAME}
echo "--- Cloud Build completed successfully ---"

# --- Prepare Environment Variables for Cloud Run ---
# This script reads your local .env file and passes the variables securely to Cloud Run.
if [ -f ../.env ]; then
  echo "--- Found .env file, preparing variables for Cloud Run ---"
  
  # Prepare an array for environment variable flags.
  ENV_VARS_FLAGS=()
  while IFS='=' read -r key value || [[ -n "$key" ]]; do
    # Skip empty lines and comments
    if [[ -z "$key" || "$key" == \#* ]]; then
      continue
    fi
    # Trim leading/trailing whitespace from key and value
    key=$(echo "$key" | xargs)
    value=$(echo "$value" | xargs)
    # Remove quotes from value, if they exist
    value="${value%\"}"
    value="${value#\"}"
    
    # Add the flag and the KEY=VALUE pair
    ENV_VARS_FLAGS+=(--set-env-vars)
    ENV_VARS_FLAGS+=("${key}=${value}")
  done < ../.env

  if [ ${#ENV_VARS_FLAGS[@]} -gt 0 ]; then
    echo "--- Variables will be set on Cloud Run. ---"
  else
    echo "--- .env file is empty, skipping variable setup. ---"
  fi
else
  ENV_VARS_FLAGS=()
  echo "--- No .env file found, skipping environment variable setup. ---"
fi

# --- Deploy to Cloud Run ---
echo "--- Deploying to Google Cloud Run ---"
gcloud run deploy ${SERVICE_NAME} \
    --image ${IMAGE_NAME} \
    --platform managed \
    --region ${REGION} \
    "${ENV_VARS_FLAGS[@]}" \
    --allow-unauthenticated \
    --port 3000

echo "--- Deployment to Cloud Run initiated ---"
echo "To see the URL of your service, run: gcloud run services describe ${SERVICE_NAME} --region ${REGION} --format 'value(status.url)'" 