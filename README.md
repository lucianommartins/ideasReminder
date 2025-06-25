# 💡 IdeasReminder - Your WhatsApp Sidekick for Capturing Brilliance! 🧠

Ever have a brilliant idea闪过 (shǎn guò - flash by) your mind, only to forget it moments later? 😫 IdeasReminder is here to help! This nifty WhatsApp bot, powered by Node.js, Express, Twilio, and Google's Gemini AI, lets you send text or voice notes to a dedicated WhatsApp number. Gemini then processes your thoughts, and for now, it sends a helpful response right back to you! 🚀 Perfect for quickly jotting down those fleeting thoughts on the go.

## ✨ Features

*   Receive WhatsApp messages (text and audio) via a Twilio webhook.
*   Process incoming text messages using Google Gemini, maintaining chat history per user.
*   Download and process incoming WhatsApp audio messages using Google Gemini.
*   Send AI-generated responses back to the user via TwiML (Twilio Markup Language).

## 🛠️ Tech Stack

This project is built with a cool blend of modern technologies:

*   **Backend:** Node.js, Express.js
*   **Language:** TypeScript
*   **Messaging:** Twilio API (for WhatsApp)
*   **AI & NLP:** Google Gemini API (specifically `gemini-2.5-flash` for text and audio processing)
*   **Environment Management:** `dotenv`
*   **HTTP Requests:** `axios` (for fetching audio files from Twilio)
*   **Development:**
    *   `ts-node`: For running TypeScript directly during development.
    *   `typescript`: For compiling TypeScript to JavaScript.

## 📋 Prerequisites

Before you dive in, make sure you have these installed on your system:

*   Node.js (v18.x or later recommended)
*   npm (which comes bundled with Node.js) or Yarn
*   Git (for cloning this awesome project!)

## 🚀 Getting Started

Follow these steps to get IdeasReminder up and running:

1.  **Clone the Repository:**
    Open your terminal and run:
    ```bash
    git clone https://github.com/lucianommartins/ideasReminder.git
    cd ideasReminder
    ```

2.  **Install Dependencies:**
    This command will download and install all the necessary packages defined in `package.json`.
    ```bash
    npm install
    ```

3.  **Set Up Environment Variables:**
    The application requires some secret keys and configuration details to function. You'll need to create a `.env` file in the root directory of the project.

    You can create this file by running:
    ```bash
    touch .env
    ```
    Then, open the newly created `.env` file and add the following lines, replacing the placeholder values with your actual credentials:

    ```env
    # Twilio Credentials
    TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
    TWILIO_AUTH_TOKEN=your_twilio_auth_token_here
    FROM_NUMBER=whatsapp:+14155238886 # Your Twilio WhatsApp Sandbox or activated number

    # Google Gemini API Key
    GEMINI_API_KEY=your_google_gemini_api_key_here

    # Server Configuration
    PORT=3000 # Or any port you prefer for the Express server
    ```

    **Where to find these credentials:**
    *   `TWILIO_ACCOUNT_SID` & `TWILIO_AUTH_TOKEN`: You can find these on your [Twilio Console dashboard](https://www.twilio.com/console).
    *   `FROM_NUMBER`: This is your Twilio WhatsApp-enabled phone number. If you're using the Twilio Sandbox for WhatsApp, this will be the Sandbox number.
    *   `GEMINI_API_KEY`: Obtain this from the [Google AI Studio](https://aistudio.google.com/app/apikey).
    *   `PORT`: The local port on which your Express server will listen for incoming webhook requests. `3000` is a common default.

4.  **Configure Twilio Webhook:**
    For Twilio to forward incoming WhatsApp messages to your running application, you need to expose your local server to the internet. Tools like [ngrok](https://ngrok.com/) are fantastic for this during development.

    *   **Start ngrok:** If your application is running on port 3000 (as per the `.env` example), run:
        ```bash
        ngrok http 3000
        ```
    *   **Get the ngrok URL:** Ngrok will provide you with a forwarding URL (e.g., `https://xxxx-xx-xxx-xx-xx.ngrok.io`). Copy the `https` URL.
    *   **Update Twilio Settings:** Go to your Twilio Console.
        *   If using a specific Twilio phone number: Navigate to Phone Numbers > Manage > Active Numbers, click on your WhatsApp-enabled number, and find the "Messaging" section.
        *   If using the Twilio Sandbox for WhatsApp: Go to Messaging > Try it out > Send a WhatsApp message.
        *   In the "WHEN A MESSAGE COMES IN" field (or similar webhook configuration field), paste your ngrok URL followed by `/webhook/twilio`. For example: `https://YOUR_NGROK_HTTPS_URL.ngrok.io/webhook/twilio`.
        *   Ensure the HTTP method is set to `POST`.
        *   Save your changes.

## ▶️ Running the Project

You have a couple of options to run the application:

*   **Development Mode (using `ts-node` for auto-recompilation on changes):**
    This is convenient during development as it automatically restarts the server when you make changes to the TypeScript files.
    ```bash
    npm start
    ```

*   **Production Mode (build first, then run the compiled JavaScript):**
    1.  **Build the project:** This command compiles your TypeScript code into JavaScript, placing the output in the `dist` directory.
        ```bash
        npm run build
        ```
    2.  **Run the compiled application:**
        ```bash
        node dist/index.js
        ```

Your server should now be running! 🎉 Send a message to your Twilio WhatsApp number, and you should see the magic happen.

## 🤔 A Note on In-Memory Storage

Currently, chat histories are stored in memory. This means that if the server restarts, all chat history will be lost. For a production environment, you'd want to integrate a persistent storage solution like a database (e.g., Redis, PostgreSQL, MongoDB).

---

Happy idea capturing! Let me know if you have more brilliant ideas for this bot. 😉 