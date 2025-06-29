#!/bin/bash
# This script checks for the existence of a Google Cloud Firestore database
# with the alias "voicetasks-db" and creates it if it doesn't exist.

set -e # Exit immediately if a command exits with a non-zero status.

PROJECT_ID=$(gcloud config get-value project)
DATABASE_ID="voicetasks-db"
LOCATION_ID="nam5" # North America - a multi-region location

if [ -z "$PROJECT_ID" ]; then
    echo "ERROR: Google Cloud project ID is not set."
    echo "Please set it using 'gcloud config set project YOUR_PROJECT_ID'"
    exit 1
fi

echo "Checking for Firestore database '$DATABASE_ID' in project '$PROJECT_ID'..."

# Check if the database already exists
# The command `gcloud firestore databases describe` will fail if the db doesn't exist.
if gcloud firestore databases describe --database="$DATABASE_ID" >/dev/null 2>&1; then
    echo "Firestore database '$DATABASE_ID' already exists."
else
    echo "Firestore database '$DATABASE_ID' does not exist. Creating it now..."
    # Create the Firestore database in Native mode.
    # Using a multi-region location like 'nam5' is good for general purpose apps.
    gcloud firestore databases create --database="$DATABASE_ID" --location="$LOCATION_ID"
    echo "Successfully created Firestore database '$DATABASE_ID' in location '$LOCATION_ID'."
fi

echo "Setup complete." 