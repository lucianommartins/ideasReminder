# 💡 VoiceTasks - Your WhatsApp Sidekick for Google Tasks

VoiceTasks is a powerful WhatsApp bot designed to be your personal assistant. It leverages Google's Gemini AI to understand your text, voice notes, and images, and integrates seamlessly with **Google Tasks** to turn fleeting ideas into actionable items.

Built to be scalable and robust, this application uses **Google Cloud Firestore** for persistent data storage, making it perfect for deployment on serverless platforms like **Google Cloud Run**.

## ✨ Features

- **Conversational AI:** Chat naturally with the Gemini model. It maintains a separate conversation history for each user.
- **Multimedia Processing:** Send audio, images, videos, or documents (PDF, DOCX, etc.) for Gemini to analyze and create tasks from.
- **Intelligent Task Management:**
    - The AI automatically identifies user intent to **create, list, or delete** tasks.
    - Tasks are automatically scheduled for the **next business day**, skipping weekends.
- **Dedicated Task List:** All tasks are organized into a specific `"GDM DevRel list"` within your Google Tasks, keeping your work organized.
- **Secure Google Integration:**
    - Connect your Google Account securely using a standard OAuth2 flow.
    - User authentication tokens are stored securely in Google Cloud Firestore.
- **Stateless & Scalable:** Designed to run efficiently on serverless platforms like Google Cloud Run.

---

## 🛠️ Tech Stack

- **Backend:** Node.js, Express.js
- **Language:** TypeScript
- **Cloud Platform:** Google Cloud Run, Google Cloud Firestore
- **Messaging:** Twilio API for WhatsApp
- **AI & NLP:** Google Gemini API
- **Google Integration:** Google Tasks API, Google Auth Library

---

## 🚀 Deployment Guide (Google Cloud Run)

### 1. Prerequisites

- A Google Cloud Platform (GCP) project with billing enabled.
- [Google Cloud SDK](https://cloud.google.com/sdk/docs/install) (`gcloud` CLI) installed and authenticated.
- A Twilio account with a configured WhatsApp number.
- Node.js (v20.x or later) installed for local testing.

### 2. Google Cloud Configuration

1.  **Set Your Project ID**
    Configure the `gcloud` CLI to use your target project.
    ```bash
    gcloud config set project YOUR_PROJECT_ID
    ```

2.  **Enable Required APIs**
    The project requires several Google Cloud APIs. Run the provided script to enable them automatically.
    ```bash
    chmod +x setup/enable_gcp_apis.sh
    ./setup/enable_gcp_apis.sh
    ```

3.  **Create the Firestore Database**
    Run the script to create the Firestore database instance for the project.
    ```bash
    chmod +x setup/setup_firestore.sh
    ./setup/setup_firestore.sh
    ```

4.  **Create OAuth 2.0 Credentials**
    - Go to the [Google Cloud Console](https://console.cloud.google.com/) -> **APIs & Services** -> **Credentials**.
    - Click **+ CREATE CREDENTIALS** -> **OAuth client ID**.
    - Select **Web application** as the application type.
    - Give it a name (e.g., "VoiceTasks-WebApp").
    - You will need a **Redirect URI** later. For now, leave it blank. Click **Create** and copy the **Client ID** and **Client Secret**.

5.  **Configure OAuth Consent Screen**
    - In the **OAuth consent screen** tab, choose **External** and create a consent screen.
    - Fill in the required app info (app name, user support email, etc.).
    - On the "Scopes" page, add the single required scope: `https://www.googleapis.com/auth/tasks`
    - On the "Test users" page, add the Google account(s) you will be testing with.
    - **Crucially**, once ready, **"PUBLISH APP"** to move it to Production to prevent refresh tokens from expiring every 7 days.

### 3. Environment Variables & Deployment

1.  **Create the `.env` file**
    Create a `.env` file in the project root with the following variables. **Leave `GOOGLE_REDIRECT_URI` blank for the first deploy.**

    ```env
    # Twilio Credentials
    TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
    TWILIO_AUTH_TOKEN=your_twilio_auth_token

    # Your Twilio WhatsApp number
    FROM_NUMBER=whatsapp:+14155238886

    # Google Gemini API Key
    GEMINI_API_KEY=your_gemini_api_key

    # Google OAuth2 Credentials (from Step 2.4)
    GOOGLE_CLIENT_ID=your_google_client_id.apps.googleusercontent.com
    GOOGLE_CLIENT_SECRET=your_google_client_secret

    # This will be your Cloud Run service URL. Example: https://voicetasks-xyz-uc.a.run.app/auth/google/callback
    GOOGLE_REDIRECT_URI=
    ```

2.  **First Deployment**
    Run the deployment script, which builds the Docker image and deploys it to Cloud Run.
    ```bash
    ./deploy/deploy.sh
    ```
    The first deployment will create the service and give you a **Service URL** (e.g., `https://voicetasks-xyz-uc.a.run.app`). **Copy this URL.**

3.  **Update Credentials and `.env`**
    - **Google Cloud Console:** Go back to your OAuth Client ID credentials. Under "Authorized redirect URIs", add `YOUR_SERVICE_URL/auth/google/callback`.
    - **`.env` file:** Now, update the `GOOGLE_REDIRECT_URI` in your `.env` file with this same URL.

4.  **Final Deployment**
    Run the deploy script again. This time, it will inject the correct environment variables, and the service will start successfully.
    ```bash
    ./deploy/deploy.sh
    ```

### 4. Configure Twilio Webhook

- Go to your Twilio number settings in the Twilio Console.
- Under "Messaging", for "A MESSAGE COMES IN", set the webhook to:
  `https://your-service-url.a.run.app/webhook/twilio`
- Ensure the method is `HTTP POST`. Your bot is now live!

## 🤖 Bot Commands

- **Any message not starting with `/`**: Starts a conversation with the Gemini AI. The AI can identify and act on requests to create, list, or delete tasks.
- `/connect_google_tasks`: Initiates the process to connect your Google Tasks account.
- `/disconnect_google_tasks`: Disconnects your Google account.
- `/status_google_tasks`: Checks if you are connected to Google.
- `/get_tasks`: Manually requests a list of all tasks in your dedicated list.
- `/help` or `/start`: Shows the welcome message.

## 🏗️ Project Structure

The project is organized into several key components within the `src/` directory:

- `index.ts`: The main entry point. Sets up the Express server, handles Twilio webhooks, and orchestrates the overall application flow.
- `components/`: Contains all the core logic, broken down by responsibility.
    - `gauth.ts`: Manages all Google authentication, including the OAuth2 flow and token refreshing.
    - `gemini.ts`: Handles all interactions with the Google Gemini API, including text and media processing.
    - `gtasks.ts`: Manages all interactions with the Google Tasks API.
    - `firestore.ts`: Centralizes all database operations with Google Cloud Firestore.
    - `prompts.ts`: Contains all system-level instructions and fixed user-facing text strings.
- `types/`: Holds all custom TypeScript type definitions and interfaces for the project.

---
Happy tasking! 