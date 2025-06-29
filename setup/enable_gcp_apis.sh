#!/bin/bash
# This script enables all the necessary Google Cloud APIs for the VoiceTasks project.

set -e # Exit immediately if a command exits with a non-zero status.

PROJECT_ID=$(gcloud config get-value project)

if [ -z "$PROJECT_ID" ]; then
    echo "ERROR: Google Cloud project ID is not set."
    echo "Please set it using 'gcloud config set project YOUR_PROJECT_ID'"
    exit 1
fi

# List of required APIs for the project
REQUIRED_APIS=(
    "iam.googleapis.com"
    "run.googleapis.com"
    "firestore.googleapis.com"
    "people.googleapis.com"
    "tasks.googleapis.com"
    "cloudbuild.googleapis.com"
)

echo "Enabling required GCP services for project '$PROJECT_ID'..."

for API in "${REQUIRED_APIS[@]}"; do
    echo "Checking status of $API..."
    # Check if the API is already enabled
    if gcloud services list --enabled --filter="config.name:$API" --format="value(config.name)" | grep -q "^$API$"; then
        echo "$API is already enabled."
    else
        echo "Enabling $API..."
        gcloud services enable "$API"
        echo "Successfully enabled $API."
    fi
done

echo "All necessary Google Cloud services have been enabled." 