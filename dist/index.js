"use strict";
/**
 * @file index.ts
 * @description This is the main entry point for the VoiceTasks application.
 * It sets up an Express server to handle incoming WhatsApp messages via a Twilio webhook.
 * The server processes text, audio, and other media messages, interacts with the
 * Google Gemini API for conversational AI, and integrates with the Google Tasks API
 * for task management. It also handles the OAuth2 flow for Google API authentication.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const twilio_1 = __importDefault(require("twilio"));
const dotenv_1 = __importDefault(require("dotenv"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const fs_2 = require("fs");
const axios_1 = __importDefault(require("axios"));
const genai_1 = require("@google/genai");
const prompts_1 = require("./components/prompts");
const gemini_1 = require("./components/gemini");
const gtasks_1 = require("./components/gtasks");
// --- INITIAL SETUP & ENVIRONMENT VALIDATION ---
dotenv_1.default.config();
const requiredEnvVars = [
    'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'FROM_NUMBER',
    'GEMINI_API_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI'
];
const missingEnvVars = requiredEnvVars.filter(key => !process.env[key]);
if (missingEnvVars.length > 0) {
    console.error(`FATAL ERROR: Missing required environment variables: ${missingEnvVars.join(', ')}`);
    process.exit(1);
}
const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, FROM_NUMBER, GEMINI_API_KEY, GOOGLE_REDIRECT_URI } = process.env;
// Dynamically derive the server's base URL from the GOOGLE_REDIRECT_URI.
let SERVER_BASE_URL;
try {
    const redirectUri = new URL(GOOGLE_REDIRECT_URI);
    SERVER_BASE_URL = redirectUri.origin;
    console.log(`index.ts: Dynamically determined SERVER_BASE_URL to be: ${SERVER_BASE_URL}`);
}
catch (error) {
    console.error('FATAL ERROR: GOOGLE_REDIRECT_URI is not a valid URL. Please check your .env file.');
    process.exit(1);
}
const app = (0, express_1.default)();
const PORT = process.env.PORT || 3000;
app.use(express_1.default.urlencoded({ extended: true }));
app.use(express_1.default.json());
const twilioClient = (0, twilio_1.default)(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const ai = new genai_1.GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const chatHistories = {};
const mediaDir = path_1.default.join('/tmp', 'media');
if (!fs_1.default.existsSync(mediaDir))
    fs_1.default.mkdirSync(mediaDir, { recursive: true });
// State object to hold media files awaiting a text prompt.
const pendingMedia = {};
// State object to track users who need to confirm a task deletion.
const pendingDeletion = {};
// --- PERSISTENCE FOR RETURNING USERS ---
const DATA_DIR = path_1.default.join(__dirname, 'data');
const RETURNING_USERS_FILE_PATH = path_1.default.join(DATA_DIR, 'returning_users.json');
let returningUsers = new Set();
/**
 * Loads the set of returning user IDs from a JSON file into memory.
 * This is called once on server startup.
 * @returns A Set containing all unique user IDs from previous sessions.
 */
function loadReturningUsers() {
    if (!fs_1.default.existsSync(DATA_DIR)) {
        console.log(`index.ts: Data directory does not exist. Creating: ${DATA_DIR}`);
        fs_1.default.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (fs_1.default.existsSync(RETURNING_USERS_FILE_PATH)) {
        try {
            const data = fs_1.default.readFileSync(RETURNING_USERS_FILE_PATH, 'utf8');
            const usersArray = JSON.parse(data);
            console.log(`index.ts: Loaded ${usersArray.length} returning users from file.`);
            return new Set(usersArray);
        }
        catch (error) {
            console.error('index.ts: Error reading or parsing returning_users.json. Starting fresh.', error);
        }
    }
    return new Set();
}
/**
 * Adds a new user's ID to the in-memory Set and persists the updated Set to the JSON file.
 * @param {string} senderId The unique ID of the new user.
 */
async function saveNewUser(senderId) {
    if (returningUsers.has(senderId))
        return; // Should not happen with current logic, but a good safeguard.
    returningUsers.add(senderId);
    console.log(`index.ts: Adding new user [${senderId}] to returning users list.`);
    try {
        const usersArray = Array.from(returningUsers);
        await fs_2.promises.writeFile(RETURNING_USERS_FILE_PATH, JSON.stringify(usersArray, null, 2));
        console.log(`index.ts: Successfully saved returning users file. Total users: ${usersArray.length}`);
    }
    catch (error) {
        console.error(`index.ts: Failed to save returning_users.json.`, error);
    }
}
/**
 * Formats a response from the Gemini model before sending it to the user.
 * @param {string} text The raw text response from Gemini.
 * @returns {string} The formatted response string.
 */
const formatGeminiResponse = (text, withGoogleSearch = false) => {
    // Trim any whitespace and remove potential surrounding quotes from the raw response
    const trimmedText = text.trim().replace(/^"|"$/g, '');
    const prefix = withGoogleSearch ? "*Gemini* ✨ (with Google Search): " : "*Gemini* ✨: ";
    return `${prefix} ${trimmedText}`;
};
/**
 * Determines if a user's message is likely a request to manage tasks (create, list, or delete).
 * This acts as a gateway to decide whether to use the more complex system instruction for Gemini.
 * @param {string} message The user's text message.
 * @returns {boolean} True if the message contains task-related keywords.
 */
function isTaskManagementRequest(message) {
    const taskKeywords = [
        // Creation
        'task', 'reminder', 'remind me', 'create task', 'create reminder', 'create a task', 'create a reminder',
        'tarefa', 'lembrete', 'criar tarefa', 'criar lembrete',
        // Listing
        'list', 'show', 'what are my', 'see my',
        'listar', 'mostrar', 'quais são', 'ver minhas',
        // Deletion
        'delete', 'remove', 'complete',
        'deletar', 'remover', 'excluir', 'completar'
    ];
    const lowerCaseMessage = message.toLowerCase();
    // Check if any of the keywords are present in the message.
    return taskKeywords.some(keyword => lowerCaseMessage.includes(keyword));
}
/**
 * Tries to find a task title from a user's reply, matching either the
 * full title or a positional reference (e.g., "the first one", "2").
 * @param reply The user's text message.
 * @param taskTitles The list of task titles presented to the user.
 * @returns The matched task title, or null if no match is found.
 */
function findTaskFromReply(reply, taskTitles) {
    const normalizedReply = reply.trim().toLowerCase();
    // 1. Direct match (case-insensitive)
    for (const title of taskTitles) {
        if (title.trim().toLowerCase() === normalizedReply) {
            return title;
        }
    }
    // 2. Numeric match (language-agnostic)
    // Extracts the first sequence of digits from the reply.
    const numericMatch = normalizedReply.match(/\d+/);
    if (numericMatch) {
        const position = parseInt(numericMatch[0], 10);
        // Check if the number is a valid position in the list (1-based).
        if (position > 0 && position <= taskTitles.length) {
            return taskTitles[position - 1]; // Array is 0-indexed
        }
    }
    return null;
}
// --- WELCOME MESSAGE FUNCTION ---
/**
 * Sends a rich, formatted welcome message to the user.
 * @param {twilio.twiml.MessagingResponse} twiml The TwiML response object.
 */
const sendWelcomeMessage = (twiml) => {
    console.log("index.ts: Sending welcome message.");
    twiml.message(prompts_1.WELCOME_MESSAGE);
};
// --- GOOGLE AUTH ROUTES ---
app.get('/auth/google/initiate', (req, res, next) => {
    try {
        const senderId = req.query.senderId;
        if (!senderId) {
            return res.status(400).send('Authentication failed: Missing user identifier.');
        }
        const authUrl = (0, gtasks_1.initiateGoogleAuth)(senderId);
        return res.redirect(authUrl);
    }
    catch (error) {
        return next(error);
    }
});
app.get('/auth/google/callback', async (req, res, next) => {
    try {
        const { code, state: senderId, error: errorQueryParam } = req.query;
        if (errorQueryParam) {
            return res.status(400).send(`<html><body><h1>Authentication Failed</h1><p>Google authentication failed: ${errorQueryParam}. You can close this page.</p></body></html>`);
        }
        if (!code || typeof code !== 'string' || !senderId || typeof senderId !== 'string') {
            return res.status(400).send('Authentication failed: Missing authorization code or user identifier.');
        }
        await (0, gtasks_1.handleGoogleAuthCallback)(code, senderId);
        try {
            await twilioClient.messages.create({
                body: prompts_1.AUTH_MESSAGES.AUTH_SUCCESS_PROACTIVE_MESSAGE,
                from: FROM_NUMBER,
                to: senderId
            });
        }
        catch (twilioError) {
            console.error(`index.ts: FAILED to send proactive success message to [${senderId}].`, twilioError);
        }
        return res.send(`
            <html>
                <head><title>Authentication Successful</title></head>
                <body>
                    <h1>Google Tasks Authentication Successful!</h1>
                    <p>Your account for WhatsApp user ${senderId} has been successfully linked with Google Tasks.</p>
                    <p>You can now close this page and return to WhatsApp.</p>
                </body>
            </html>
        `);
    }
    catch (error) {
        return next(error);
    }
});
// --- MAIN TWILIO WEBHOOK ---
app.post('/webhook/twilio', async (req, res) => {
    console.log('index.ts: POST /webhook/twilio - Request received.');
    const { MessagingResponse } = twilio_1.default.twiml;
    const twiml = new MessagingResponse();
    const senderId = req.body.From;
    const numMedia = parseInt(req.body.NumMedia || '0', 10);
    if (!senderId) {
        console.error('index.ts: Critical - Missing senderId (From) in webhook request. Cannot process.');
        res.status(400).send('Sender ID missing.');
        return;
    }
    console.log(`index.ts: Processing request for sender [${senderId}], Number of media items: ${numMedia}`);
    if (numMedia > 0) {
        console.log(`index.ts: Detected [${numMedia}] media item(s) from sender [${senderId}].`);
        if (numMedia > 1) {
            console.warn(`index.ts: User [${senderId}] sent ${numMedia} media files. Responding with an error message.`);
            twiml.message(prompts_1.MEDIA_MESSAGES.ERROR_MULTIPLE_MEDIA);
            res.type('text/xml').send(twiml.toString());
            return;
        }
        else {
            const mediaUrl = req.body.MediaUrl0;
            const mediaContentType = req.body.MediaContentType0;
            let localMediaFilePath; // To be accessible in the finally block for cleanup
            let geminiMediaResponse;
            const userMessage = req.body.Body; // Corrected variable name
            if (!mediaUrl || !mediaContentType) {
                console.error(`index.ts: Missing MediaUrl0 or MediaContentType0 for media message from [${senderId}].`);
                twiml.message(prompts_1.MEDIA_MESSAGES.ERROR_RECEIVING_MEDIA);
            }
            else {
                try {
                    console.log(`index.ts: Downloading media for [${senderId}]: URL [${mediaUrl}], Type [${mediaContentType}]`);
                    localMediaFilePath = await downloadAndSaveMediaFile(mediaUrl, mediaContentType, senderId);
                    console.log(`index.ts: Download complete. Path: [${localMediaFilePath}]. Determining media type for Gemini processing for [${senderId}].`);
                    // Supported MIME types based on user's provided list
                    const supportedImageTypes = ['image/jpeg', 'image/png', 'image/webp'];
                    const supportedAudioTypes = ['audio/ogg', 'audio/amr', 'audio/3gpp', 'audio/aac', 'audio/mpeg'];
                    const supportedDocumentTypes = [
                        'application/pdf',
                        'application/msword', // DOC
                        'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // DOCX
                        'application/vnd.openxmlformats-officedocument.presentationml.presentation', // PPTX
                        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' // XLSX
                    ];
                    const supportedVideoTypes = ['video/mp4'];
                    // Determine the prompt: use user's message if available, otherwise use fixed prompt
                    let effectivePrompt;
                    const useSystemInstructionForTask = userMessage ? isTaskManagementRequest(userMessage) : false;
                    if (supportedAudioTypes.includes(mediaContentType)) {
                        effectivePrompt = (userMessage && userMessage.trim() !== "") ? userMessage : prompts_1.FIXED_TEXT_PROMPT_FOR_AUDIO;
                        console.log(`index.ts: Processing downloaded audio for [${senderId}]. Prompt: "${effectivePrompt}"`);
                        geminiMediaResponse = await (0, gemini_1.processAudioWithGemini)(ai, senderId, localMediaFilePath, mediaContentType, effectivePrompt, chatHistories, useSystemInstructionForTask);
                    }
                    else if (supportedImageTypes.includes(mediaContentType) || supportedVideoTypes.includes(mediaContentType) || supportedDocumentTypes.includes(mediaContentType)) {
                        if (userMessage && userMessage.trim() !== "") {
                            // If there is a text message along with the media, process it directly
                            effectivePrompt = userMessage;
                            console.log(`index.ts: Processing media with user-provided text for [${senderId}]. Prompt: "${effectivePrompt}"`);
                            if (supportedImageTypes.includes(mediaContentType)) {
                                geminiMediaResponse = await (0, gemini_1.processImageWithGemini)(ai, senderId, localMediaFilePath, mediaContentType, effectivePrompt, chatHistories, useSystemInstructionForTask);
                            }
                            else if (supportedVideoTypes.includes(mediaContentType)) {
                                geminiMediaResponse = await (0, gemini_1.processVideoWithGemini)(ai, senderId, localMediaFilePath, mediaContentType, effectivePrompt, chatHistories, useSystemInstructionForTask);
                            }
                            else { // Document
                                geminiMediaResponse = await (0, gemini_1.processDocumentWithGemini)(ai, senderId, localMediaFilePath, mediaContentType, effectivePrompt, chatHistories, useSystemInstructionForTask);
                            }
                        }
                        else {
                            // If there is no text, store the media and ask the user what to do with it
                            console.log(`index.ts: Media received without prompt from [${senderId}]. Storing and asking for instructions.`);
                            pendingMedia[senderId] = { filePath: localMediaFilePath, mimeType: mediaContentType };
                            twiml.message(prompts_1.MEDIA_MESSAGES.PROMPT_FOR_MEDIA);
                            // We set localMediaFilePath to undefined to prevent it from being deleted in the finally block
                            localMediaFilePath = undefined;
                        }
                    }
                    else {
                        console.warn(`index.ts: User [${senderId}] sent an unsupported media file type: ${mediaContentType}.`);
                        twiml.message(prompts_1.MEDIA_MESSAGES.UNSUPPORTED_MEDIA_TYPE);
                    }
                    if (geminiMediaResponse === undefined && !twiml.response.children.length) {
                        geminiMediaResponse = prompts_1.MEDIA_MESSAGES.RESPONSE_MEDIA_NO_TEXT;
                        console.warn(`index.ts: Gemini media processing for a supported type returned an empty/undefined response for [${senderId}]. Using fallback message.`);
                    }
                    if (geminiMediaResponse && !twiml.response.children.length) { // Only add message if not already set (e.g., by unsupported type)
                        // For media responses, we don't currently detect search usage, so we pass false.
                        twiml.message(formatGeminiResponse(geminiMediaResponse, false));
                    }
                    if (geminiMediaResponse) {
                        console.log(`index.ts: Media processing by Gemini complete for [${senderId}]. Response prepared: "${geminiMediaResponse}"`);
                    }
                }
                catch (error) {
                    console.error(`index.ts: Error processing media message for [${senderId}]:`, error);
                    twiml.message(prompts_1.MEDIA_MESSAGES.ERROR_PROCESSING_MEDIA);
                }
                finally {
                    if (localMediaFilePath) {
                        console.log(`index.ts: Attempting to delete local media file: ${localMediaFilePath} for [${senderId}] in finally block.`);
                        try {
                            await fs_2.promises.unlink(localMediaFilePath);
                            console.log(`index.ts: Successfully deleted local media file: ${localMediaFilePath}`);
                        }
                        catch (unlinkError) {
                            console.error(`index.ts: Failed to delete local media file ${localMediaFilePath}:`, unlinkError);
                        }
                    }
                }
            }
        }
    }
    else {
        // --- TEXT MESSAGE HANDLING ---
        const incomingMsg = req.body.Body;
        console.log(`index.ts: No media detected. Processing as text message from [${senderId}]: "${incomingMsg || '[empty message]'}"`);
        if (!incomingMsg) {
            console.warn(`index.ts: Missing Body (text content) for message from [${senderId}]. Sending generic reply.`);
            twiml.message(prompts_1.GENERAL_MESSAGES.EMPTY_MESSAGE_BODY);
        }
        else {
            // Check if the user has interacted before by checking our persistent store.
            const isNewUser = !returningUsers.has(senderId);
            if (isNewUser) {
                console.log(`index.ts: New user detected [${senderId}]. Sending welcome message and saving user.`);
                sendWelcomeMessage(twiml);
                await saveNewUser(senderId);
                // End the interaction here to prevent Gemini from also responding to the "hello" message.
                res.writeHead(200, { 'Content-Type': 'text/xml' });
                res.end(twiml.toString());
                return;
            }
            // Normalize message for easier command parsing
            const lowerCaseMsg = incomingMsg.toLowerCase().trim();
            if (lowerCaseMsg === '/connect_google_tasks') {
                console.log(`index.ts: Received /connect_google_tasks command from [${senderId}].`);
                if ((0, gtasks_1.isUserAuthenticated)(senderId)) {
                    console.log(`index.ts: User [${senderId}] is already authenticated. Informing the user.`);
                    twiml.message(prompts_1.AUTH_MESSAGES.ALREADY_AUTHENTICATED);
                }
                else {
                    console.log(`index.ts: User [${senderId}] is not authenticated. Generating auth URL.`);
                    const initiationUrl = `${SERVER_BASE_URL}/auth/google/initiate?senderId=${encodeURIComponent(senderId)}`;
                    console.log(`index.ts: Sending rich auth initiation message to [${senderId}].`);
                    twiml.message(prompts_1.AUTH_MESSAGES.INITIATE_AUTH_INSTRUCTIONS[0]);
                    twiml.message(prompts_1.AUTH_MESSAGES.INITIATE_AUTH_INSTRUCTIONS[1].replace('{authUrl}', initiationUrl));
                }
            }
            else if (lowerCaseMsg === '/disconnect_google_tasks') {
                console.log(`index.ts: Received /disconnect_google_tasks command from [${senderId}].`);
                const cleared = (0, gtasks_1.clearUserTokens)(senderId);
                if (cleared) {
                    twiml.message(prompts_1.AUTH_MESSAGES.DISCONNECT_SUCCESS);
                }
                else {
                    twiml.message(prompts_1.AUTH_MESSAGES.DISCONNECT_FAILURE);
                }
            }
            else if (lowerCaseMsg === '/status_google_tasks') {
                console.log(`index.ts: Received /status_google_tasks command from [${senderId}].`);
                const statusMessage = await (0, gtasks_1.getAuthStatus)(senderId);
                twiml.message(statusMessage);
            }
            else if (lowerCaseMsg === '/help' || lowerCaseMsg === '/start') {
                console.log(`index.ts: Received /help or /start command from [${senderId}]. Resending welcome message.`);
                sendWelcomeMessage(twiml);
            }
            else {
                // If the message starts with '/' it's an attempt at a command that we don't recognize.
                if (incomingMsg.trim().startsWith('/')) {
                    twiml.message(prompts_1.INVALID_COMMAND_MESSAGE);
                }
                else {
                    // --- State-Based Action Handling (Deletion Confirmation) ---
                    if (pendingDeletion[senderId]) {
                        console.log(`User [${senderId}] is in a pending deletion state. Trying to match reply: "${incomingMsg}"`);
                        const taskTitles = pendingDeletion[senderId];
                        const taskTitleToConfirm = findTaskFromReply(incomingMsg, taskTitles);
                        if (taskTitleToConfirm) {
                            console.log(`Match found. Deleting task "${taskTitleToConfirm}" for [${senderId}].`);
                            const deletionMessage = await (0, gtasks_1.deleteGoogleTask)(senderId, taskTitleToConfirm);
                            twiml.message(deletionMessage);
                            delete pendingDeletion[senderId]; // Clear the state on success
                        }
                        else {
                            console.log(`No match found for deletion reply from [${senderId}].`);
                            twiml.message(`I didn't understand. Please reply with the exact task title or its number in the list.`);
                            // Do not clear state, allowing the user to try again.
                        }
                        res.writeHead(200, { 'Content-Type': 'text/xml' });
                        res.end(twiml.toString());
                        return;
                    }
                    // This block is now only reached for returning users.
                    const pendingUserMedia = pendingMedia[senderId];
                    if (pendingUserMedia) {
                        // A media file is awaiting a prompt for this user.
                        console.log(`index.ts: Found pending media for [${senderId}]. Processing with new prompt: "${incomingMsg}"`);
                        let geminiMediaResponse;
                        const { filePath, mimeType } = pendingUserMedia;
                        const useSystemInstructionForTask = isTaskManagementRequest(incomingMsg);
                        try {
                            // Use the stored media with the new text prompt
                            if (mimeType.startsWith('image/')) {
                                geminiMediaResponse = await (0, gemini_1.processImageWithGemini)(ai, senderId, filePath, mimeType, incomingMsg, chatHistories, useSystemInstructionForTask);
                            }
                            else if (mimeType.startsWith('video/')) {
                                geminiMediaResponse = await (0, gemini_1.processVideoWithGemini)(ai, senderId, filePath, mimeType, incomingMsg, chatHistories, useSystemInstructionForTask);
                            }
                            else { // Document
                                geminiMediaResponse = await (0, gemini_1.processDocumentWithGemini)(ai, senderId, filePath, mimeType, incomingMsg, chatHistories, useSystemInstructionForTask);
                            }
                            if (geminiMediaResponse) {
                                twiml.message(formatGeminiResponse(geminiMediaResponse, false));
                            }
                            else {
                                twiml.message(prompts_1.MEDIA_MESSAGES.RESPONSE_PENDING_MEDIA_NO_TEXT);
                            }
                        }
                        catch (error) {
                            console.error(`index.ts: Error processing pending media for [${senderId}]:`, error);
                            twiml.message(prompts_1.MEDIA_MESSAGES.ERROR_PROCESSING_PENDING_MEDIA);
                        }
                        finally {
                            // Clean up the stored media file and the pending state
                            console.log(`index.ts: Deleting processed pending media file: ${filePath}`);
                            await fs_2.promises.unlink(filePath).catch(err => console.error(`Failed to delete pending file: ${err}`));
                            delete pendingMedia[senderId];
                        }
                    }
                    else {
                        // Standard text chat logic
                        if (!chatHistories[senderId]) {
                            chatHistories[senderId] = [];
                        }
                        console.log(`index.ts: No command recognized. Passing to Gemini for sender [${senderId}].`);
                        const useSystemInstructionForTask = isTaskManagementRequest(incomingMsg);
                        const { responseText: geminiResponseText, googleSearchUsed } = await (0, gemini_1.generateGeminiChatResponse)(ai, senderId, incomingMsg, chatHistories, useSystemInstructionForTask);
                        console.log(`index.ts: Raw response from Gemini for [${senderId}]: "${geminiResponseText}" (Google Search Used: ${googleSearchUsed})`);
                        let actionWasHandled = false;
                        try {
                            // Gemini can sometimes wrap its JSON response in markdown (```json ... ```).
                            // This regex extracts the first JSON-like object from the string.
                            const jsonMatch = geminiResponseText.match(/\{[\s\S]*\}/);
                            if (jsonMatch) {
                                const jsonString = jsonMatch[0];
                                const parsedJson = JSON.parse(jsonString);
                                // --- Handle Task Listing Request ---
                                if (parsedJson && parsedJson.isTaskListRequest === true) {
                                    actionWasHandled = true;
                                    console.log(`index.ts: Gemini identified a task list request for [${senderId}].`);
                                    if (!(0, gtasks_1.isUserAuthenticated)(senderId)) {
                                        twiml.message(prompts_1.AUTH_MESSAGES.TASK_CREATION_AUTH_REQUIRED);
                                    }
                                    else {
                                        console.log(`index.ts: Fetching and formatting tasks for [${senderId}].`);
                                        const formattedTasks = await (0, gtasks_1.getFormattedTasksString)(senderId);
                                        twiml.message(formattedTasks);
                                    }
                                }
                                // --- Handle Task Deletion Request ---
                                else if (parsedJson && parsedJson.isTaskDeletionRequest === true) {
                                    actionWasHandled = true;
                                    const { taskTitle } = parsedJson;
                                    if (!(0, gtasks_1.isUserAuthenticated)(senderId)) {
                                        twiml.message(prompts_1.AUTH_MESSAGES.TASK_CREATION_AUTH_REQUIRED);
                                    }
                                    else {
                                        // If a specific task title is provided, delete it directly.
                                        if (taskTitle) {
                                            console.log(`index.ts: Deleting task "${taskTitle}" for [${senderId}].`);
                                            const deletionMessage = await (0, gtasks_1.deleteGoogleTask)(senderId, taskTitle);
                                            twiml.message(deletionMessage);
                                        }
                                        else {
                                            // If no task title is provided, start the follow-up dialog.
                                            console.log(`index.ts: Ambiguous deletion request from [${senderId}]. Starting follow-up.`);
                                            const taskTitles = await (0, gtasks_1.getTaskTitles)(senderId);
                                            if (taskTitles && taskTitles.length > 0) {
                                                const titleList = taskTitles.map((title, index) => `${index + 1}. ${title}`).join('\n');
                                                twiml.message(`Which task would you like to delete?\n\n${titleList}`);
                                                pendingDeletion[senderId] = taskTitles; // Set the pending state with the list of titles
                                            }
                                            else {
                                                twiml.message("You don't have any tasks to delete.");
                                            }
                                        }
                                    }
                                }
                                // --- Handle Task Creation Request ---
                                else if (parsedJson && parsedJson.isTask === true && parsedJson.details) {
                                    actionWasHandled = true;
                                    console.log(`index.ts: Gemini identified a task creation request for [${senderId}].`);
                                    const taskDetails = parsedJson.details;
                                    if (!(0, gtasks_1.isUserAuthenticated)(senderId)) {
                                        twiml.message(prompts_1.AUTH_MESSAGES.TASK_CREATION_AUTH_REQUIRED);
                                    }
                                    else {
                                        console.log(`index.ts: Creating Google Task for [${senderId}].`);
                                        const creationResponse = await (0, gtasks_1.createGoogleTask)(senderId, taskDetails);
                                        if (typeof creationResponse === 'string') {
                                            twiml.message(creationResponse);
                                        }
                                        else {
                                            const taskTitle = creationResponse.title ?? 'Untitled Task';
                                            const successMessage = prompts_1.TASK_MESSAGES.SUCCESS(taskTitle);
                                            twiml.message(successMessage);
                                            console.log(`index.ts: Successfully created task titled "${taskTitle}" for [${senderId}].`);
                                        }
                                    }
                                }
                            }
                        }
                        catch (error) {
                            // This catch block is for when the regex finds a JSON-like object, but it's not valid JSON.
                            // We log it and then let it fall through to be treated as a normal chat message.
                            console.warn(`index.ts: Failed to parse potential JSON from Gemini response for [${senderId}]. Error: ${error}`);
                        }
                        // --- Fallback to Normal Chat ---
                        // If no specific action was identified and handled, treat it as a standard chat message.
                        if (!actionWasHandled) {
                            console.log(`index.ts: No actionable JSON found. Treating as a regular chat message for [${senderId}].`);
                            if (!geminiResponseText) {
                                twiml.message(prompts_1.GENERAL_MESSAGES.GEMINI_EMPTY_RESPONSE);
                                console.warn(`index.ts: Gemini chat returned an empty response for [${senderId}]. Using fallback message.`);
                            }
                            else {
                                twiml.message(formatGeminiResponse(geminiResponseText, googleSearchUsed));
                            }
                        }
                    }
                }
            }
        }
    }
    console.log(`index.ts: Sending final TwiML response to [${senderId}].`);
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(twiml.toString());
});
// --- UTILITY FUNCTIONS ---
// This function downloads media from a Twilio URL and saves it to a local temporary file.
async function downloadAndSaveMediaFile(mediaUrl, mediaContentType, senderId) {
    const sanitizedSenderId = senderId.replace(/[^a-zA-Z0-9]/g, '_');
    const fileExtension = mediaContentType.split('/')[1] || 'tmp';
    const localFilePath = path_1.default.join(mediaDir, `${sanitizedSenderId}-${Date.now()}.${fileExtension}`);
    const response = await (0, axios_1.default)({
        method: 'GET',
        url: mediaUrl,
        responseType: 'stream',
        auth: {
            username: TWILIO_ACCOUNT_SID,
            password: TWILIO_AUTH_TOKEN
        }
    });
    const writer = fs_1.default.createWriteStream(localFilePath);
    response.data.pipe(writer);
    return new Promise((resolve, reject) => {
        writer.on('finish', () => resolve(localFilePath));
        writer.on('error', reject);
    });
}
// --- START EXPRESS SERVER ---
// Load returning users from file before starting the server.
returningUsers = loadReturningUsers();
app.listen(PORT, () => {
    console.log(`index.ts: Express server started and listening on port ${PORT}.`);
    console.log(`index.ts: Twilio webhook endpoint available at /webhook/twilio`);
    console.log(`index.ts: Google OAuth initiation route available at ${SERVER_BASE_URL}/auth/google/initiate?senderId=YOUR_SENDER_ID`);
    console.log(`index.ts: Google OAuth callback configured for ${GOOGLE_REDIRECT_URI}`);
});
