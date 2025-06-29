/**
 * @file index.ts
 * @description This is the main entry point for the VoiceTasks application.
 * It sets up an Express server to handle incoming WhatsApp messages via a Twilio webhook.
 * The server processes text, audio, and other media messages, interacts with the
 * Google Gemini API for conversational AI, and integrates with the Google Tasks API
 * for task management. It also handles the OAuth2 flow for Google API authentication.
 */

import express, { Request, Response, NextFunction } from 'express';
import twilio from 'twilio';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { promises as fsPromises } from 'fs';
import axios from 'axios';
import { GoogleGenAI } from '@google/genai';
import { ChatHistories, IdentifiedTask } from './types/chat';
import {
    WELCOME_MESSAGE,
    INVALID_COMMAND_MESSAGE,
    AUTH_MESSAGES,
    MEDIA_MESSAGES,
    GENERAL_MESSAGES,
    TASK_MESSAGES,
    FIXED_TEXT_PROMPT_FOR_AUDIO
} from './components/prompts';
import {
    processAudioWithGemini,
    processImageWithGemini,
    processVideoWithGemini,
    processDocumentWithGemini,
    generateGeminiChatResponse
} from './components/gemini';
import {
    initiateGoogleAuth,
    handleGoogleAuthCallback,
    isUserAuthenticated,
    clearUserTokens,
    getAuthStatus
} from './components/gauth';
import { 
    listTaskLists,
    getTasksInList,
    createGoogleTask,
    getFormattedTasksString,
    deleteGoogleTask,
    getTaskTitles
} from './components/gtasks';

// --- INITIAL SETUP & ENVIRONMENT VALIDATION ---
dotenv.config();

// --- START: Troubleshooting Environment Variables ---
console.log("--- Troubleshooting Environment Variables ---");
console.log(`TWILIO_ACCOUNT_SID: ${process.env.TWILIO_ACCOUNT_SID}`);
console.log(`TWILIO_AUTH_TOKEN: ${process.env.TWILIO_AUTH_TOKEN}`);
console.log(`FROM_NUMBER: ${process.env.FROM_NUMBER}`);
console.log(`GEMINI_API_KEY: ${process.env.GEMINI_API_KEY}`);
console.log(`GOOGLE_CLIENT_ID: ${process.env.GOOGLE_CLIENT_ID}`);
console.log(`GOOGLE_CLIENT_SECRET: ${process.env.GOOGLE_CLIENT_SECRET}`);
console.log(`GOOGLE_REDIRECT_URI: ${process.env.GOOGLE_REDIRECT_URI}`);
console.log("--- End Troubleshooting ---");

const requiredEnvVars = [
    'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'FROM_NUMBER', 
    'GEMINI_API_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI'
];

const missingEnvVars = requiredEnvVars.filter(key => !process.env[key]);
if (missingEnvVars.length > 0) {
    console.error(`FATAL ERROR: Missing required environment variables: ${missingEnvVars.join(', ')}`);
    process.exit(1);
}

const { 
    TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, FROM_NUMBER,
    GEMINI_API_KEY, GOOGLE_REDIRECT_URI
} = process.env;

// Dynamically derive the server's base URL from the GOOGLE_REDIRECT_URI.
let SERVER_BASE_URL: string;
try {
    const redirectUri = new URL(GOOGLE_REDIRECT_URI!);
    SERVER_BASE_URL = redirectUri.origin;
    console.log(`index.ts: Dynamically determined SERVER_BASE_URL to be: ${SERVER_BASE_URL}`);
} catch (error) {
    console.error('FATAL ERROR: GOOGLE_REDIRECT_URI is not a valid URL. Please check your .env file.');
    process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
const chatHistories: ChatHistories = {};
const mediaDir = path.join('/tmp', 'media');
if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });

// State object to hold media files awaiting a text prompt.
const pendingMedia: { [senderId: string]: { filePath: string; mimeType: string } } = {};
// State object to track users who need to confirm a task deletion.
const pendingDeletion: { [senderId: string]: string[] } = {};

// --- PERSISTENCE FOR RETURNING USERS ---
const DATA_DIR = path.join(__dirname, 'data');
const RETURNING_USERS_FILE_PATH = path.join(DATA_DIR, 'returning_users.json');
let returningUsers: Set<string> = new Set();

/**
 * Loads the set of returning user IDs from a JSON file into memory.
 * This is called once on server startup.
 * @returns A Set containing all unique user IDs from previous sessions.
 */
function loadReturningUsers(): Set<string> {
    if (!fs.existsSync(DATA_DIR)) {
        console.log(`index.ts: Data directory does not exist. Creating: ${DATA_DIR}`);
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (fs.existsSync(RETURNING_USERS_FILE_PATH)) {
        try {
            const data = fs.readFileSync(RETURNING_USERS_FILE_PATH, 'utf8');
            const usersArray = JSON.parse(data) as string[];
            console.log(`index.ts: Loaded ${usersArray.length} returning users from file.`);
            return new Set(usersArray);
        } catch (error) {
            console.error('index.ts: Error reading or parsing returning_users.json. Starting fresh.', error);
        }
    }
    return new Set();
}

/**
 * Adds a new user's ID to the in-memory Set and persists the updated Set to the JSON file.
 * @param {string} senderId The unique ID of the new user.
 */
async function saveNewUser(senderId: string): Promise<void> {
    if (returningUsers.has(senderId)) return; // Should not happen with current logic, but a good safeguard.
    
    returningUsers.add(senderId);
    console.log(`index.ts: Adding new user [${senderId}] to returning users list.`);
    
    try {
        const usersArray = Array.from(returningUsers);
        await fsPromises.writeFile(RETURNING_USERS_FILE_PATH, JSON.stringify(usersArray, null, 2));
        console.log(`index.ts: Successfully saved returning users file. Total users: ${usersArray.length}`);
    } catch (error) {
        console.error(`index.ts: Failed to save returning_users.json.`, error);
    }
}

/**
 * Formats a response from the Gemini model before sending it to the user.
 * @param {string} text The raw text response from Gemini.
 * @returns {string} The formatted response string.
 */
const formatGeminiResponse = (text: string, withGoogleSearch: boolean = false): string => {
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
function isTaskManagementRequest(message: string): boolean {
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
function findTaskFromReply(reply: string, taskTitles: string[]): string | null {
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
const sendWelcomeMessage = (twiml: twilio.twiml.MessagingResponse) => {
    console.log("index.ts: Sending welcome message.");
    twiml.message(WELCOME_MESSAGE);
};

// --- GOOGLE AUTH ROUTES ---
app.get('/auth/google/initiate', (req: Request, res: Response, next: NextFunction) => {
    try {
        const senderId = req.query.senderId as string;
        if (!senderId) {
            return res.status(400).send('Authentication failed: Missing user identifier.');
        }
        const authUrl = initiateGoogleAuth(senderId);
        return res.redirect(authUrl);
    } catch (error) {
        return next(error);
    }
});

app.get('/auth/google/callback', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { code, state: senderId, error: errorQueryParam } = req.query;
        if (errorQueryParam) {
            return res.status(400).send(`<html><body><h1>Authentication Failed</h1><p>Google authentication failed: ${errorQueryParam}. You can close this page.</p></body></html>`);
        }
        if (!code || typeof code !== 'string' || !senderId || typeof senderId !== 'string') {
            return res.status(400).send('Authentication failed: Missing authorization code or user identifier.');
        }
        await handleGoogleAuthCallback(code, senderId);
        try {
            await twilioClient.messages.create({
                body: AUTH_MESSAGES.AUTH_SUCCESS_PROACTIVE_MESSAGE,
                from: FROM_NUMBER!,
                to: senderId
            });
        } catch (twilioError) {
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
    } catch (error) {
        return next(error);
    }
});

// --- MAIN TWILIO WEBHOOK ---
app.post('/webhook/twilio', async (req: Request, res: Response) => {
    console.log('index.ts: POST /webhook/twilio - Request received.');
    const { MessagingResponse } = twilio.twiml;
    const twiml = new MessagingResponse();

    const senderId = req.body.From as string | undefined;
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
            twiml.message(MEDIA_MESSAGES.ERROR_MULTIPLE_MEDIA);
            res.type('text/xml').send(twiml.toString());
            return;
        } else {
            const mediaUrl = req.body.MediaUrl0 as string | undefined;
            const mediaContentType = req.body.MediaContentType0 as string | undefined;
            let localMediaFilePath: string | undefined; // To be accessible in the finally block for cleanup
            let geminiMediaResponse: string | undefined;
            const userMessage = req.body.Body as string | undefined; // Corrected variable name

            if (!mediaUrl || !mediaContentType) {
                console.error(`index.ts: Missing MediaUrl0 or MediaContentType0 for media message from [${senderId}].`);
                twiml.message(MEDIA_MESSAGES.ERROR_RECEIVING_MEDIA);
            } else {
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
                    let effectivePrompt: string;
                    const useSystemInstructionForTask = userMessage ? isTaskManagementRequest(userMessage) : false;

                    if (supportedAudioTypes.includes(mediaContentType)) {
                        effectivePrompt = (userMessage && userMessage.trim() !== "") ? userMessage : FIXED_TEXT_PROMPT_FOR_AUDIO;
                        console.log(`index.ts: Processing downloaded audio for [${senderId}]. Prompt: "${effectivePrompt}"`);
                        geminiMediaResponse = await processAudioWithGemini(ai, senderId, localMediaFilePath, mediaContentType, effectivePrompt, chatHistories, useSystemInstructionForTask);
                    } else if (supportedImageTypes.includes(mediaContentType) || supportedVideoTypes.includes(mediaContentType) || supportedDocumentTypes.includes(mediaContentType)) {
                        if (userMessage && userMessage.trim() !== "") {
                            // If there is a text message along with the media, process it directly
                            effectivePrompt = userMessage;
                            console.log(`index.ts: Processing media with user-provided text for [${senderId}]. Prompt: "${effectivePrompt}"`);
                            if (supportedImageTypes.includes(mediaContentType)) {
                                geminiMediaResponse = await processImageWithGemini(ai, senderId, localMediaFilePath, mediaContentType, effectivePrompt, chatHistories, useSystemInstructionForTask);
                            } else if (supportedVideoTypes.includes(mediaContentType)) {
                                geminiMediaResponse = await processVideoWithGemini(ai, senderId, localMediaFilePath, mediaContentType, effectivePrompt, chatHistories, useSystemInstructionForTask);
                            } else { // Document
                                geminiMediaResponse = await processDocumentWithGemini(ai, senderId, localMediaFilePath, mediaContentType, effectivePrompt, chatHistories, useSystemInstructionForTask);
                            }
                        } else {
                            // If there is no text, store the media and ask the user what to do with it
                            console.log(`index.ts: Media received without prompt from [${senderId}]. Storing and asking for instructions.`);
                            pendingMedia[senderId] = { filePath: localMediaFilePath, mimeType: mediaContentType };
                            twiml.message(MEDIA_MESSAGES.PROMPT_FOR_MEDIA);
                            // We set localMediaFilePath to undefined to prevent it from being deleted in the finally block
                            localMediaFilePath = undefined; 
                        }
                    } else {
                        console.warn(`index.ts: User [${senderId}] sent an unsupported media file type: ${mediaContentType}.`);
                        twiml.message(MEDIA_MESSAGES.UNSUPPORTED_MEDIA_TYPE);
                    }

                    if (geminiMediaResponse === undefined && !twiml.response.children.length) {
                        geminiMediaResponse = MEDIA_MESSAGES.RESPONSE_MEDIA_NO_TEXT;
                        console.warn(`index.ts: Gemini media processing for a supported type returned an empty/undefined response for [${senderId}]. Using fallback message.`);
                    }
                    
                    if (geminiMediaResponse && !twiml.response.children.length) { // Only add message if not already set (e.g., by unsupported type)
                        // For media responses, we don't currently detect search usage, so we pass false.
                        twiml.message(formatGeminiResponse(geminiMediaResponse, false));
                    }
                    
                    if (geminiMediaResponse) {
                         console.log(`index.ts: Media processing by Gemini complete for [${senderId}]. Response prepared: "${geminiMediaResponse}"`);
                    }

                } catch (error) {
                    console.error(`index.ts: Error processing media message for [${senderId}]:`, error);
                    twiml.message(MEDIA_MESSAGES.ERROR_PROCESSING_MEDIA);
                } finally {
                    if (localMediaFilePath) {
                        console.log(`index.ts: Attempting to delete local media file: ${localMediaFilePath} for [${senderId}] in finally block.`);
                        try {
                            await fsPromises.unlink(localMediaFilePath);
                            console.log(`index.ts: Successfully deleted local media file: ${localMediaFilePath}`);
                        } catch (unlinkError) {
                            console.error(`index.ts: Failed to delete local media file ${localMediaFilePath}:`, unlinkError);
                        }
                    }
                }
            }
        }
    } else {
        // --- TEXT MESSAGE HANDLING ---
        const incomingMsg = req.body.Body as string | undefined;
        console.log(`index.ts: No media detected. Processing as text message from [${senderId}]: "${incomingMsg || '[empty message]'}"`);

        if (!incomingMsg) {
            console.warn(`index.ts: Missing Body (text content) for message from [${senderId}]. Sending generic reply.`);
            twiml.message(GENERAL_MESSAGES.EMPTY_MESSAGE_BODY);
        } else {
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
                
                if (isUserAuthenticated(senderId)) {
                    console.log(`index.ts: User [${senderId}] is already authenticated. Informing the user.`);
                    twiml.message(AUTH_MESSAGES.ALREADY_AUTHENTICATED);
                } else {
                    console.log(`index.ts: User [${senderId}] is not authenticated. Generating auth URL.`);
                    const initiationUrl = `${SERVER_BASE_URL}/auth/google/initiate?senderId=${encodeURIComponent(senderId)}`;
                    
                    console.log(`index.ts: Sending rich auth initiation message to [${senderId}].`);
                    twiml.message(AUTH_MESSAGES.INITIATE_AUTH_INSTRUCTIONS.replace('{authUrl}', initiationUrl));
                }
            
            } else if (lowerCaseMsg === '/disconnect_google_tasks') {
                console.log(`index.ts: Received /disconnect_google_tasks command from [${senderId}].`);
                const cleared = clearUserTokens(senderId);
                if (cleared) {
                    twiml.message(AUTH_MESSAGES.DISCONNECT_SUCCESS);
                } else {
                    twiml.message(AUTH_MESSAGES.DISCONNECT_FAILURE);
                }
            
            } else if (lowerCaseMsg === '/status_google_tasks') {
                console.log(`index.ts: Received /status_google_tasks command from [${senderId}].`);
                const statusMessage = await getAuthStatus(senderId);
                twiml.message(statusMessage);

            } else if (lowerCaseMsg === '/help' || lowerCaseMsg === '/start') {
                console.log(`index.ts: Received /help or /start command from [${senderId}]. Resending welcome message.`);
                sendWelcomeMessage(twiml);
            } else {
                // If the message starts with '/' it's an attempt at a command that we don't recognize.
                if (incomingMsg.trim().startsWith('/')) {
                    twiml.message(INVALID_COMMAND_MESSAGE);
                } else {
                    // --- State-Based Action Handling (Deletion Confirmation) ---
                    if (pendingDeletion[senderId]) {
                        console.log(`User [${senderId}] is in a pending deletion state. Trying to match reply: "${incomingMsg}"`);
                        const taskTitles = pendingDeletion[senderId];
                        const taskTitleToConfirm = findTaskFromReply(incomingMsg, taskTitles);

                        if (taskTitleToConfirm) {
                            console.log(`Match found. Deleting task "${taskTitleToConfirm}" for [${senderId}].`);
                            const deletionMessage = await deleteGoogleTask(senderId, taskTitleToConfirm);
                            twiml.message(deletionMessage);
                            delete pendingDeletion[senderId]; // Clear the state on success
                        } else {
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
                        let geminiMediaResponse: string | undefined;
                        const { filePath, mimeType } = pendingUserMedia;
                        const useSystemInstructionForTask = isTaskManagementRequest(incomingMsg);

                        try {
                            // Use the stored media with the new text prompt
                            if (mimeType.startsWith('image/')) {
                                geminiMediaResponse = await processImageWithGemini(ai, senderId, filePath, mimeType, incomingMsg, chatHistories, useSystemInstructionForTask);
                            } else if (mimeType.startsWith('video/')) {
                                geminiMediaResponse = await processVideoWithGemini(ai, senderId, filePath, mimeType, incomingMsg, chatHistories, useSystemInstructionForTask);
                            } else { // Document
                                geminiMediaResponse = await processDocumentWithGemini(ai, senderId, filePath, mimeType, incomingMsg, chatHistories, useSystemInstructionForTask);
                            }

                            if (geminiMediaResponse) {
                                twiml.message(formatGeminiResponse(geminiMediaResponse, false));
                            } else {
                                twiml.message(MEDIA_MESSAGES.RESPONSE_PENDING_MEDIA_NO_TEXT);
                            }

                        } catch (error) {
                            console.error(`index.ts: Error processing pending media for [${senderId}]:`, error);
                            twiml.message(MEDIA_MESSAGES.ERROR_PROCESSING_PENDING_MEDIA);
                        } finally {
                            // Clean up the stored media file and the pending state
                            console.log(`index.ts: Deleting processed pending media file: ${filePath}`);
                            await fsPromises.unlink(filePath).catch(err => console.error(`Failed to delete pending file: ${err}`));
                            delete pendingMedia[senderId];
                        }
                    } else {
                        // Standard text chat logic
                        if (!chatHistories[senderId]) {
                            chatHistories[senderId] = [];
                        }
                        console.log(`index.ts: No command recognized. Passing to Gemini for sender [${senderId}].`);
                        const useSystemInstructionForTask = isTaskManagementRequest(incomingMsg);
                        const { responseText: geminiResponseText, googleSearchUsed } = await generateGeminiChatResponse(ai, senderId, incomingMsg, chatHistories, useSystemInstructionForTask);
                        
                        console.log(`index.ts: Raw response from Gemini for [${senderId}]: "${geminiResponseText}" (Google Search Used: ${googleSearchUsed})`);

                        let actionWasHandled = false;
                        try {
                            const jsonMatch = geminiResponseText.match(/\{[\s\S]*\}/);

                            if (jsonMatch) {
                                const jsonString = jsonMatch[0];
                                const parsedJson = JSON.parse(jsonString);

                                // --- Handle Task Creation Request ---
                                if (parsedJson && parsedJson.isTask === true && parsedJson.details) {
                                    actionWasHandled = true;
                                    console.log(`index.ts: Gemini identified a task creation request for [${senderId}].`);
                                    const taskDetails = (parsedJson as IdentifiedTask).details;

                                    if (!isUserAuthenticated(senderId)) {
                                        twiml.message(AUTH_MESSAGES.TASK_CREATION_AUTH_REQUIRED);
                                    } else {
                                        console.log(`index.ts: Calling createGoogleTask for [${senderId}] with details:`, JSON.stringify(taskDetails, null, 2));
                                        
                                        // Combine all details into a single description string for the Google Task notes.
                                        const combinedDescription = [
                                            `Description: ${taskDetails.description}`,
                                            `Final Result: ${taskDetails.final_result}`,
                                            `User Experience: ${taskDetails.user_experience}`
                                        ].join('\n\n');

                                        const result = await createGoogleTask(senderId, {
                                            title: taskDetails.objective,
                                            description: combinedDescription,
                                        });

                                        if (typeof result === 'string') {
                                            twiml.message(result); // Send error message
                                        } else {
                                            const taskTitle = result.title ?? 'Untitled Task';
                                            const successMessage = TASK_MESSAGES.SUCCESS(taskTitle);
                                            twiml.message(successMessage);
                                            console.log(`index.ts: Successfully created task titled "${taskTitle}" for [${senderId}].`);
                                        }
                                    }
                                }
                                // --- Handle Task Listing Request ---
                                else if (parsedJson.isTaskListRequest === true) {
                                    actionWasHandled = true;
                                    console.log(`index.ts: Gemini identified a task list request for [${senderId}].`);
                                    if (!isUserAuthenticated(senderId)) {
                                        twiml.message(AUTH_MESSAGES.TASK_LISTING_AUTH_REQUIRED);
                                    } else {
                                        const tasksString = await getFormattedTasksString(senderId);
                                        twiml.message(tasksString);
                                        console.log(`index.ts: Successfully sent task list to [${senderId}].`);
                                    }
                                }
                                // --- Handle Task Deletion Request ---
                                else if (parsedJson.isTaskDeletionRequest === true) {
                                    actionWasHandled = true;
                                    console.log(`index.ts: Gemini identified a task deletion request for [${senderId}].`);
                                    if (!isUserAuthenticated(senderId)) {
                                        twiml.message(AUTH_MESSAGES.TASK_DELETION_AUTH_REQUIRED);
                                    } else {
                                        // Fetch the user's current tasks to present them for deletion.
                                        const taskTitles = await getTaskTitles(senderId);
                                        if (taskTitles && taskTitles.length > 0) {
                                            // Store the list of task titles in the pendingDeletion state.
                                            pendingDeletion[senderId] = taskTitles;
                                            // Format the message to list the tasks for the user.
                                            const tasksListForDeletion = taskTitles.map((title, index) => `${index + 1}. ${title}`).join('\n');
                                            const deletionPrompt = `${TASK_MESSAGES.DELETION_PROMPT}\n${tasksListForDeletion}`;
                                            twiml.message(deletionPrompt);
                                            console.log(`index.ts: Prompting user [${senderId}] to select a task for deletion.`);
                                        } else {
                                            twiml.message(TASK_MESSAGES.DELETION_NO_TASKS);
                                            console.log(`index.ts: User [${senderId}] tried to delete a task, but they have none.`);
                                        }
                                    }
                                }
                                // NOTE: Other JSON-based actions like listing/deleting would be handled here with 'else if'
                            } 
                        } catch (error) {
                            console.warn(`index.ts: Failed to parse potential JSON from Gemini response for [${senderId}]. Error: ${error}`);
                        }

                        // --- Fallback to Normal Chat ---
                        if (!actionWasHandled) {
                            console.log(`index.ts: No actionable JSON found. Treating as a regular chat message for [${senderId}].`);
                            if (!geminiResponseText) {
                                twiml.message(GENERAL_MESSAGES.GEMINI_EMPTY_RESPONSE);
                            } else {
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
async function downloadAndSaveMediaFile(mediaUrl: string, mediaContentType: string, senderId: string): Promise<string> {
    const sanitizedSenderId = senderId.replace(/[^a-zA-Z0-9]/g, '_');
    const fileExtension = mediaContentType.split('/')[1] || 'tmp';
    const localFilePath = path.join(mediaDir, `${sanitizedSenderId}-${Date.now()}.${fileExtension}`);
    
    const response = await axios({
        method: 'GET',
        url: mediaUrl,
        responseType: 'stream',
        auth: {
            username: TWILIO_ACCOUNT_SID!,
            password: TWILIO_AUTH_TOKEN!
        }
    });

    const writer = fs.createWriteStream(localFilePath);
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