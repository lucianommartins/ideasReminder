"use strict";
/**
 * @file prompts.ts
 * @description This file centralizes all system-level and fixed text prompts used for interacting with the Gemini API and responding to users.
 * This approach improves organization and makes it easier to manage and update the prompts.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TASK_MESSAGES = exports.GENERAL_MESSAGES = exports.MEDIA_MESSAGES = exports.AUTH_MESSAGES = exports.INVALID_COMMAND_MESSAGE = exports.WELCOME_MESSAGE = exports.FIXED_TEXT_PROMPT_FOR_AUDIO = exports.systemInstruction = void 0;
// =================================================================================================
// ==                                  GEMINI-SPECIFIC PROMPTS                                    ==
// =================================================================================================
/**
 * System-level instructions to prime the Gemini model for its role as a task identifier.
 */
exports.systemInstruction = `
Your primary role is to be a world-class assistant for identifying and structuring tasks from user messages.

You have four modes of operation:
1. "Task Creation Mode": If the user's message implies they want to create a task, a to-do, a reminder, or any actionable item.
2. "Task Listing Mode": If the user's message implies they want to see, list, or check their existing tasks.
3. "Task Deletion Mode": If the user's message implies they want to delete, remove, or complete a task.
4. "Normal Chat Mode": For any other type of conversation.

**Rules for Task Creation Mode:**
- If you determine the user wants to create a task, you MUST respond ONLY with a valid JSON object. Do not include any other text, greetings, or explanations before or after the JSON.
- The JSON object must have the exact following structure:
  {
    "isTask": true,
    "details": {
      "objective": "A concise, clear title for the task. (e.g., 'Develop new login page')",
      "description": "A detailed breakdown of the task requirements. (e.g., 'Create a responsive login page with email/password fields and a Google sign-in button.')",
      "final_result": "The expected outcome when the task is complete. (e.g., 'A fully functional and tested login page deployed to the staging environment.')",
      "user_experience": "How this task benefits the end-user. (e.g., 'Users will have a modern, secure, and easy way to access their accounts.')"
    }
  }
- You must infer and populate all four fields in the "details" object from the user's message. If the user is vague, use your reasoning to create a logical structure based on what they provided.

**Rules for Task Listing Mode:**
- If you determine the user wants to list their tasks, you MUST respond ONLY with the following valid JSON object:
  {
    "isTaskListRequest": true
  }
- Examples of phrases for this mode: "list my tasks", "what are my reminders?", "show me my to-do list", "liste minhas tarefas", "o que eu tenho pra fazer?".

**Rules for Task Deletion Mode:**
- If you determine the user wants to delete a task, you MUST extract the title of the task from their message.
- You MUST then respond ONLY with the following valid JSON object.
- If the user provides a specific title, populate the "taskTitle" field with it.
- If the user expresses intent to delete but does NOT provide a title (e.g., "I want to delete a task"), set "taskTitle" to null.
  {
    "isTaskDeletionRequest": true,
    "taskTitle": "The exact title of the task to be deleted, or null if not specified"
  }
- Examples of phrases for this mode: "delete my task 'buy milk'", "remove the reminder to call John", "complete the 'finish report' task", "exclua a tarefa 'pagar a conta de luz'".
- Example of a phrase that should result in a null title: "delete one of my tasks", "I need to remove a to-do".

**Rules for Normal Chat Mode:**
- If the message is NOT a task creation, listing, or deletion request (e.g., it's a greeting, a question, a random statement), you must respond as a friendly, helpful assistant.
- Your response in this mode MUST be a simple string.
- Do NOT use JSON in this mode.

**Response Style (for Normal Chat Mode):**
- As you are a WhatsApp bot, all your responses must be concise and to the point.
- Avoid long paragraphs. Use line breaks to structure information if needed, but keep the overall message brief.
- Do not be so brief that you lose important information. The goal is clarity and conciseness, not shortness for its own sake.

**Language Priming:**
- IMPORTANT: You MUST respond in the exact same language the user uses. If they use Portuguese, you respond in Portuguese (for both chat and the content of the JSON fields). If they use English, you respond in English.

**Tool Usage:**
- You have access to a Google Search tool. Use it ONLY if the user asks a question that requires real-time information, specific facts, or data that you wouldn't know otherwise. Do not use it for general conversation.
`.trim();
/**
 * A fixed prompt to be used for audio messages when the user does not provide a specific text prompt.
 */
exports.FIXED_TEXT_PROMPT_FOR_AUDIO = "answer the question present in this audio. if there is no question, interpret what the user said and ask what the user wants to do with this information";
// =================================================================================================
// ==                                  APPLICATION STRINGS                                        ==
// =================================================================================================
// --- Welcome & Help ---
exports.WELCOME_MESSAGE = `
👋 Hello! I'm *VoiceTasks*, your personal assistant for Google Tasks! 📝

With me, you can turn your ideas into tasks—whether by text, audio, or even images—directly here on WhatsApp. Just describe what you need, and I'll handle the rest.

*Here are the main commands:*

🤖 *General Conversation:*
- Any message that doesn't start with \`/\` begins a conversation with the AI. Just chat naturally!

🔗 *Connecting to Google Tasks:*
- \`/connect_google_tasks\`: Connect your Google Tasks account.
- \`/disconnect_google_tasks\`: Disconnect your account.
- \`/status_google_tasks\`: Check your connection status.
- \`/help\` or \`/start\`: Show this welcome message again.

💡 *How can I help you today?*
Send an idea or an audio message, and let's get it done!
`.trim().replace(/^ +/gm, '');
exports.INVALID_COMMAND_MESSAGE = `
Invalid command. Please use one of the available commands:

• */connect_google_tasks* - Connect your Google Tasks account.
• */disconnect_google_tasks* - Disconnect your Google Tasks account.
• */status_google_tasks* - Check the status and expiry of your connection.
• */help* or */start* - Show this welcome message again.

Any other message (not starting with /) will be treated as a conversation with the AI.
`.trim().replace(/^ +/gm, '');
// --- Google Authentication ---
exports.AUTH_MESSAGES = {
    ALREADY_AUTHENTICATED: "You are already connected to Google Tasks. You can start using commands like '/list_task_lists'.\n\nIf you want to connect a different account, first disconnect the current one using the command: /disconnect_google_tasks",
    INITIATE_AUTH_INSTRUCTIONS: [
        "To connect your Google Tasks account, please open this link in your browser",
        "{authUrl}", // Placeholder for the URL
    ],
    DISCONNECT_SUCCESS: 'Your Google Tasks account has been disconnected. Your tokens have been cleared.',
    DISCONNECT_FAILURE: 'No active Google Tasks connection found to disconnect.',
    AUTH_SUCCESS_PROACTIVE_MESSAGE: '✅ Authentication with Google Tasks was successful! You can now use task-related commands.',
    TASK_CREATION_AUTH_REQUIRED: "I've structured your task, but you need to connect your Google account first. Please use the command `/connect_google_tasks` and then send your task request again."
};
// --- Media Handling ---
exports.MEDIA_MESSAGES = {
    ERROR_MULTIPLE_MEDIA: "Please send only one media file at a time.",
    ERROR_RECEIVING_MEDIA: "There was an issue receiving your media file. Please try again.",
    UNSUPPORTED_MEDIA_TYPE: "The media file type you sent is not currently supported. Please try an image, audio, video, or a common document format (PDF, DOCX, PPTX, XLSX).",
    PROMPT_FOR_MEDIA: "I received your file. What would you like me to do with it?",
    ERROR_PROCESSING_MEDIA: "Sorry, I encountered an error trying to understand your media message. Please try again later.",
    ERROR_PROCESSING_PENDING_MEDIA: "Sorry, I encountered an error with your file. Please try sending it again.",
    RESPONSE_MEDIA_NO_TEXT: "I received your media, but I couldn't formulate a response right now. Please try again.",
    RESPONSE_PENDING_MEDIA_NO_TEXT: "I received your instructions, but couldn't process the file. Please try again."
};
// --- General & Fallback ---
exports.GENERAL_MESSAGES = {
    EMPTY_MESSAGE_BODY: "Thanks for your message! If you meant to send text, please try again, or send an audio message.",
    GEMINI_EMPTY_RESPONSE: "I'm having a little trouble thinking right now. Please try again in a moment!"
};
// --- Task Creation ---
exports.TASK_MESSAGES = {
    SUCCESS: (title) => `✅ Task created successfully!\n\n*${title}* has been added to your Google Tasks and is scheduled for tomorrow at 9 AM.`
};
