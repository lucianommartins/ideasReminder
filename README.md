# 💡 IdeasReminder - Your WhatsApp Sidekick for Ideas and Tasks! 🧠

Ever have a brilliant idea闪过 (shǎn guò - flash by) your mind, only to forget it moments later? IdeasReminder is here to help! This WhatsApp bot, powered by Node.js, Express, Twilio, and Google's Gemini AI, not only captures your thoughts but also integrates seamlessly with your **Google Tasks**, turning fleeting ideas into actionable items.

Send text, voice notes, or even images, and let Gemini process them. Or, use simple commands to manage your Google Tasks directly from WhatsApp.

## ✨ Features

*   **Conversational AI:** Chat naturally with the Gemini Pro model. It maintains a separate conversation history for each user.
*   **Multimedia Processing:** Send audio, images, videos, or documents (PDF, DOCX, etc.) for Gemini to analyze and discuss.
*   **Google Tasks Integration:**
    *   Securely connect your Google Account using an OAuth2 flow.
    *   List all your Google Task lists.
    *   View tasks within any specific list.
    *   Add new tasks to your default list with a simple command.
    *   Check the status of your connection.
*   **Persistent Connections:** User authentication tokens for Google Tasks are securely stored, so you only need to connect your account once.
*   **Command-Driven Interface:** A clear set of commands for interacting with Google Tasks, with a helpful guide for invalid commands.

## 🛠️ Tech Stack

*   **Backend:** Node.js, Express.js
*   **Language:** TypeScript
*   **Messaging:** Twilio API (for WhatsApp)
*   **AI & NLP:** Google Gemini API
*   **Google Integration:** Google Tasks API, Google Auth Library
*   **Environment Management:** `dotenv`
*   **HTTP Requests:** `axios`

## 🚀 Getting Started

### 1. Prerequisites

*   Node.js (v18.x or later)
*   npm (or Yarn)
*   Git
*   An [ngrok](https://ngrok.com/) account to expose your local server to the internet for Twilio webhooks.

### 2. Clone the Repository
```bash
git clone https://github.com/lucianommartins/ideasReminder.git
cd ideasReminder
```

### 3. Install Dependencies
```bash
npm install
```

### 4. Google Cloud Project Setup

To use the Google Tasks integration, you need to set up a project in the Google Cloud Console.

1.  **Create a Project:** Go to the [Google Cloud Console](https://console.cloud.google.com/) and create a new project.
2.  **Enable APIs:** In your new project, go to the "APIs & Services" dashboard and click "+ ENABLE APIS AND SERVICES". Search for and enable the **Google Tasks API**.
3.  **Configure OAuth Consent Screen:**
    *   Go to "APIs & Services" > "OAuth consent screen".
    *   Choose **External** and create a new consent screen.
    *   Fill in the required app information (app name, user support email, developer contact).
    *   On the "Scopes" page, click "Add or Remove Scopes" and add the scope for the Google Tasks API: `../auth/tasks`.
    *   On the "Test users" page, add the Google account(s) you will be testing with.
    *   **Crucially**, once you are ready, go back to the "OAuth consent screen" and click **"PUBLISH APP"** to move it from "Testing" to "In production". This ensures your refresh tokens do not expire every 7 days.

4.  **Create Credentials:**
    *   Go to "APIs & Services" > "Credentials".
    *   Click "+ CREATE CREDENTIALS" and choose "OAuth client ID".
    *   Select **Web application** as the application type.
    *   Under "Authorized redirect URIs", click "+ ADD URI" and add the URL that ngrok will provide. For now, you can use a placeholder like `http://localhost:3000/auth/google/callback`, but you will need to update this later.
    *   Click "Create". You will be shown your **Client ID** and **Client Secret**. Copy these securely.

### 5. Set Up Environment Variables

Create a `.env` file in the root of the project:
```bash
touch .env
```

Open the file and add the following variables, replacing the placeholders with your actual credentials:

```env
# Twilio Credentials
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your_twilio_auth_token

# Your Twilio number (the one sending messages)
FROM_NUMBER=whatsapp:+14155238886

# Google Gemini API Key
GEMINI_API_KEY=your_gemini_api_key

# Google OAuth2 Credentials
GOOGLE_CLIENT_ID=your_google_client_id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your_google_client_secret
# This MUST match the redirect URI you configured in your Google Cloud credentials
# and it MUST use the HTTPS ngrok URL for the live application.
GOOGLE_REDIRECT_URI=https://YOUR_NGROK_HTTPS_URL.ngrok.io/auth/google/callback

# Server Port
PORT=3000
```

### 6. Run the Application and Configure Webhooks

1.  **Start the local server:**
    ```bash
    npm start
    ```

2.  **Expose your server with ngrok:**
    In a new terminal, run:
    ```bash
    ngrok http 3000
    ```
    Ngrok will give you a public HTTPS URL (e.g., `https://xxxx-xxxx-xxxx.ngrok.io`). **Copy this URL.**

3.  **Update Google Redirect URI:**
    *   Go back to your [Google Cloud Console Credentials](https://console.cloud.google.com/apis/credentials).
    *   Edit your OAuth 2.0 Client ID.
    *   Update the "Authorized redirect URI" to be your ngrok HTTPS URL followed by `/auth/google/callback`.
    *   **Example:** `https://xxxx-xxxx-xxxx.ngrok.io/auth/google/callback`
    *   Update the `GOOGLE_REDIRECT_URI` in your `.env` file to match this exactly.

4.  **Configure Twilio Webhook:**
    *   Go to your Twilio number settings in the Twilio Console.
    *   Under the "Messaging" section, in the "A MESSAGE COMES IN" field, set the webhook to your ngrok HTTPS URL followed by `/webhook/twilio`.
    *   **Example:** `https://xxxx-xxxx-xxxx.ngrok.io/webhook/twilio`
    *   Ensure the HTTP method is set to `POST`.
    *   Save your changes.

5.  **Restart the Node.js server** to apply the changes from your `.env` file.

## 🤖 Bot Commands

Interact with the bot using the following commands in WhatsApp:

*   **Any message not starting with `/`**: Starts or continues a conversation with the Gemini AI.

*   `/connect_google_tasks`: Initiates the process to connect your Google Tasks account. The bot will send you a unique link to authorize the application.
*   `/disconnect_google_tasks`: Disconnects your Google Tasks account and deletes your stored authentication tokens.
*   `/status_google_tasks`: Checks if you are connected and shows when your current access token expires.
*   `/list_task_lists`: Displays all of your Google Task lists.
*   `/show_tasks <list_name>`: Shows all active tasks from a specific list. Use `@default` for your default task list.
*   `/add_task <task_description>`: Adds a new task with the given description to your default task list.

---

Happy idea capturing and task managing! 