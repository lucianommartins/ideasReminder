# 💡 VoiceTasks - Your WhatsApp Sidekick for Ideas and Tasks! 🧠

VoiceTasks is a powerful WhatsApp bot designed to be your personal assistant. It leverages Google's Gemini AI to understand your text, voice notes, and images, and integrates seamlessly with **Google Tasks** to turn fleeting ideas into actionable items.

Built to be scalable and robust, this application uses **Google Cloud Firestore** for persistent data storage, making it perfect for deployment on serverless platforms like **Google Cloud Run**.

## ✨ Features

*   **Conversational AI:** Chat naturally with the Gemini Pro model. It maintains a separate conversation history for each user.
*   **Multimedia Processing:** Send audio, images, videos, or documents (PDF, DOCX, etc.) for Gemini to analyze and discuss.
*   **Deep Google Tasks Integration:**
    *   Securely connect your Google Account using an OAuth2 flow.
    *   Let Gemini intelligently create, list, and manage your tasks.
    *   Use simple commands like `/status_google_tasks` to check your connection.
*   **Persistent & Scalable:** All user data, including authentication tokens, is stored securely in Google Cloud Firestore, ensuring no data is lost between server instances or deploys.
*   **Stateless Architecture:** Designed to run efficiently on serverless platforms like Google Cloud Run.

## 🛠️ Tech Stack

*   **Backend:** Node.js, Express.js
*   **Language:** TypeScript
*   **Cloud Platform:** Google Cloud Run, Google Cloud Firestore
*   **Messaging:** Twilio API (for WhatsApp)
*   **AI & NLP:** Google Gemini API
*   **Google Integration:** Google Tasks API, Google People API, Google Auth Library

---

## 🚀 Deployment Guide (Google Cloud Run)

This guide covers deploying the application to Google Cloud Run.

### 1. Prerequisites

*   Node.js (v18.x or later)
*   A Google Cloud Platform (GCP) project with billing enabled.
*   [Google Cloud SDK](https://cloud.google.com/sdk/docs/install) (the `gcloud` command-line tool) installed and authenticated.
*   A Twilio account with a configured WhatsApp number.

### 2. Initial Setup

1.  **Clone the Repository**
    ```bash
    git clone https://github.com/your-username/VoiceTasks.git
    cd VoiceTasks
    ```

2.  **Install Dependencies**
    ```bash
    npm install
    ```

### 3. Google Cloud Configuration

1.  **Set Your Project ID**
    Make sure `gcloud` is configured to use your target project.
    ```bash
    gcloud config set project YOUR_PROJECT_ID
    ```

2.  **Enable Required APIs**
    The project requires several Google Cloud APIs. Run the provided script to enable them automatically.
    ```bash
    chmod +x setup/enable_gcp_apis.sh
    ./setup/enable_gcp_apis.sh
    ```
    This will enable Cloud Run, Firestore, Cloud Build, and other necessary services.

3.  **Create the Firestore Database**
    Next, run the script to create the Firestore database instance for the project.
    ```bash
    chmod +x setup/setup_firestore.sh
    ./setup/setup_firestore.sh
    ```
    This creates a database with the ID `voicetasks-db`.

4.  **Create OAuth 2.0 Credentials**
    *   Go to the [Google Cloud Console](https://console.cloud.google.com/) -> **APIs & Services** -> **Credentials**.
    *   Click **+ CREATE CREDENTIALS** -> **OAuth client ID**.
    *   Select **Web application** as the application type.
    *   Give it a name (e.g., "VoiceTasks-WebApp").
    *   You will need a **Redirect URI** later. For now, you can leave it blank or add a placeholder like `http://localhost`. We will update this after the first deploy.
    *   Click **Create**. Copy the **Client ID** and **Client Secret**. You will need these for your `.env` file.

5.  **Configure OAuth Consent Screen**
    *   In the **OAuth consent screen** tab, choose **External** and create a new consent screen.
    *   Fill in the required app information (app name, user support email, developer contact).
    *   On the "Scopes" page, add the following scopes:
        *   `openid`
        *   `https://www.googleapis.com/auth/userinfo.profile`
        *   `https://www.googleapis.com/auth/user.addresses.read`
        *   `https://www.googleapis.com/auth/tasks`
    *   On the "Test users" page, add the Google account(s) you will be testing with.
    *   **Crucially**, once you are ready, go back and click **"PUBLISH APP"** to move it to "Production" mode. This prevents refresh tokens from expiring every 7 days.

### 4. Environment Variables & Deployment

1.  **Create the `.env` file**
    Create a file named `.env` in the root of the project and add the following, filling in your credentials. **Leave `GOOGLE_REDIRECT_URI` blank for now.**

    ```env
    # Twilio Credentials
    TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
    TWILIO_AUTH_TOKEN=your_twilio_auth_token

    # Your Twilio WhatsApp number
    FROM_NUMBER=whatsapp:+14155238886

    # Google Gemini API Key
    GEMINI_API_KEY=your_gemini_api_key

    # Google OAuth2 Credentials (from Step 3.4)
    GOOGLE_CLIENT_ID=your_google_client_id.apps.googleusercontent.com
    GOOGLE_CLIENT_SECRET=your_google_client_secret

    # The URI for the Google Auth callback. We will get this URL after deploying.
    # Example: https://voicetasks-service-xyz-uc.a.run.app/auth/google/callback
    GOOGLE_REDIRECT_URI=

    # Server Port (Cloud Run provides this automatically, but it's good for local testing)
    PORT=8080
    ```

2.  **First Deployment to Cloud Run**
    Run the deployment script. You can specify your GCP region.
    ```bash
    ./deploy/deploy.sh us-central1
    ```
    The first deployment will likely fail to start correctly because `GOOGLE_REDIRECT_URI` is missing, but it will create the service and give you a **Service URL** (e.g., `https://voicetasks-service-xyz-uc.a.run.app`). **Copy this URL.**

3.  **Update Credentials and `.env` file**
    *   **Google Cloud Console:** Go back to your OAuth Client ID credentials. Under "Authorized redirect URIs", add the following:
        `YOUR_SERVICE_URL/auth/google/callback`
        (e.g., `https://voicetasks-service-xyz-uc.a.run.app/auth/google/callback`)
    *   **.env file:** Now, update the `GOOGLE_REDIRECT_URI` in your `.env` file with this same URL.

4.  **Final Deployment**
    Run the deploy script again. This time, it will inject the correct environment variables, and the service will start successfully.
    ```bash
    ./deploy/deploy.sh us-central1
    ```

### 5. Configure Twilio Webhook

*   Go to your Twilio number settings in the Twilio Console.
*   Under the "Messaging" section, in the "A MESSAGE COMES IN" field, set the webhook to your Cloud Run Service URL followed by `/webhook/twilio`.
*   **Example:** `https://voicetasks-service-xyz-uc.a.run.app/webhook/twilio`
*   Ensure the HTTP method is set to `HTTP POST`.
*   Save your changes. Your bot is now live!

## 🤖 Bot Commands

Interact with the bot using the following commands in WhatsApp:

*   **Any message not starting with `/`**: Starts or continues a conversation with the Gemini AI. The AI can now identify and act on requests to create, list, or delete tasks.
*   `/connect_google_tasks`: Initiates the process to connect your Google Tasks account.
*   `/disconnect_google_tasks`: Disconnects your Google Tasks account and deletes your token from Firestore.
*   `/status_google_tasks`: Checks if you are connected to Google.
*   `/help` or `/start`: Shows the initial welcome message.

---

Happy idea capturing and task managing! 