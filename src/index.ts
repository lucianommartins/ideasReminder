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
import { isReturningUser, addNewUser } from './components/firestore';

// --- INITIAL SETUP & ENVIRONMENT VALIDATION ---
dotenv.config();

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

// --- STATE MANAGEMENT ---
// These objects hold temporary, in-memory state for the application.
const pendingMedia: { [senderId: string]: { filePath: string; mimeType: string } } = {};
const pendingDeletion: { [senderId: string]: string[] } = {};

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

/**
 * A centralized function to process Gemini's response. It checks for actionable JSON
 * (for creating, listing, or deleting tasks) and handles it. Otherwise, it formats
 * the response as a standard chat message.
 * @param responseText The raw text response from the Gemini API.
 * @param googleSearchUsed A boolean indicating if Google Search was used.
 * @param senderId The user's unique identifier.
 * @param twiml The Twilio TwiML response object.
 */
async function handleGeminiResponse(responseText: string, googleSearchUsed: boolean, senderId: string, twiml: twilio.twiml.MessagingResponse) {
    if (!responseText) {
        twiml.message(GENERAL_MESSAGES.GEMINI_EMPTY_RESPONSE);
        return;
    }

    try {
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            throw new Error("Response from Gemini was not valid JSON.");
        }

        const jsonString = jsonMatch[0];
        const parsedJson: IdentifiedTask = JSON.parse(jsonString);

        const isAuthenticated = await isUserAuthenticated(senderId);

        if (parsedJson.isTask) {
            console.log(`index.ts: Gemini identified a task for creation from [${senderId}].`);
            if (!isAuthenticated) {
                twiml.message(AUTH_MESSAGES.TASK_CREATION_AUTH_REQUIRED);
            } else {
                // Calculate due date for the next business day.
                const tomorrow = new Date();
                tomorrow.setHours(0, 0, 0, 0); // Start with a clean slate at midnight.

                const dayOfWeek = tomorrow.getDay(); // Sunday = 0, Monday = 1, ..., Saturday = 6

                if (dayOfWeek >= 1 && dayOfWeek <= 4) { // Monday to Thursday
                    tomorrow.setDate(tomorrow.getDate() + 1);
                } else if (dayOfWeek === 5) { // Friday
                    tomorrow.setDate(tomorrow.getDate() + 3); // Skip Saturday and Sunday
                } else if (dayOfWeek === 6) { // Saturday
                    tomorrow.setDate(tomorrow.getDate() + 2); // Skip Sunday
                } else { // Sunday (dayOfWeek === 0)
                    tomorrow.setDate(tomorrow.getDate() + 1);
                }

                const taskResult = await createGoogleTask(senderId, {
                    title: parsedJson.details.objective,
                    description: `Description: ${parsedJson.details.description}\nFinal Result: ${parsedJson.details.final_result}\nUser Experience: ${parsedJson.details.user_experience}`,
                    dueDate: tomorrow.toISOString(),
                });
                if (typeof taskResult === 'string') {
                    twiml.message(taskResult);
                } else {
                    twiml.message(TASK_MESSAGES.SUCCESS(taskResult.title || 'Untitled Task'));
                }
            }
        } else if (parsedJson.isTaskListRequest) {
            console.log(`index.ts: Gemini identified a task listing request from [${senderId}].`);
            if (!isAuthenticated) {
                twiml.message(AUTH_MESSAGES.TASK_LISTING_AUTH_REQUIRED);
            } else {
                const tasksString = await getFormattedTasksString(senderId);
                twiml.message(tasksString);
            }
        } else if (parsedJson.isTaskDeletionRequest) {
            console.log(`index.ts: Gemini identified a task deletion request from [${senderId}].`);
            if (!isAuthenticated) {
                twiml.message(AUTH_MESSAGES.TASK_DELETION_AUTH_REQUIRED);
            } else if (parsedJson.taskTitle) {
                const deletionResult = await deleteGoogleTask(senderId, parsedJson.taskTitle);
                twiml.message(deletionResult);
            } else {
                const taskTitles = await getTaskTitles(senderId);
                if (taskTitles && taskTitles.length > 0) {
                    pendingDeletion[senderId] = taskTitles;
                    const numberedTasks = taskTitles.map((title, i) => `${i + 1}. ${title}`).join('\n');
                    twiml.message(`${TASK_MESSAGES.DELETION_PROMPT}\n\n${numberedTasks}`);
                } else {
                    twiml.message(TASK_MESSAGES.DELETION_NO_TASKS);
                }
            }
        } else {
            console.warn(`index.ts: Received unexpected but valid JSON from Gemini for [${senderId}]. Treating as normal chat.`);
            twiml.message(formatGeminiResponse(responseText, googleSearchUsed));
        }
    } catch (e) {
        // Not JSON, so it's a normal chat response
        twiml.message(formatGeminiResponse(responseText, googleSearchUsed));
    }
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
            return res.status(400).send(`
                <!DOCTYPE html>
                <html lang="en">
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>Authentication Failed</title>
                    <style>
                        body {
                            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
                            background-color: #f0f2f5;
                            display: flex;
                            justify-content: center;
                            align-items: center;
                            height: 100vh;
                            margin: 0;
                            color: #333;
                        }
                        .container {
                            text-align: center;
                            background-color: #ffffff;
                            padding: 40px;
                            border-radius: 12px;
                            box-shadow: 0 4px 12px rgba(0,0,0,0.1);
                            max-width: 500px;
                            width: 90%;
                        }
                        .logo {
                            width: 200px;
                            margin-bottom: 24px;
                        }
                        h1 {
                            font-size: 24px;
                            color: #EA4335; /* Google Red */
                            margin-bottom: 16px;
                        }
                        p {
                            font-size: 16px;
                            line-height: 1.6;
                            margin-bottom: 8px;
                        }
                        .error-message {
                            font-weight: 500;
                            color: #555;
                            word-break: break-all;
                        }
                        .footer {
                            margin-top: 24px;
                            font-size: 14px;
                            color: #888;
                        }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <img src="https://upload.wikimedia.org/wikipedia/commons/5/56/Google_DeepMind_logo.png" alt="Google DeepMind Logo" class="logo">
                        <h1>Authentication Failed</h1>
                        <p>An error occurred during the authentication process:</p>
                        <p><span class="error-message">${errorQueryParam}</span></p>
                        <p class="footer">You can close this page and try again from WhatsApp.</p>
                    </div>
                </body>
                </html>
            `);
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
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Authentication Successful</title>
                <style>
                    body {
                        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
                        background-color: #f0f2f5;
                        display: flex;
                        justify-content: center;
                        align-items: center;
                        height: 100vh;
                        margin: 0;
                        color: #333;
                    }
                    .container {
                        text-align: center;
                        background-color: #ffffff;
                        padding: 40px;
                        border-radius: 12px;
                        box-shadow: 0 4px 12px rgba(0,0,0,0.1);
                        max-width: 500px;
                        width: 90%;
                    }
                    .logo {
                        width: 200px;
                        margin-bottom: 24px;
                    }
                    h1 {
                        font-size: 24px;
                        color: #4285F4; /* Google Blue */
                        margin-bottom: 16px;
                    }
                    p {
                        font-size: 16px;
                        line-height: 1.6;
                        margin-bottom: 8px;
                    }
                    .user-id {
                        font-weight: 500;
                        color: #555;
                        word-break: break-all;
                    }
                    .footer {
                        margin-top: 24px;
                        font-size: 14px;
                        color: #888;
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <img src="https://upload.wikimedia.org/wikipedia/commons/5/56/Google_DeepMind_logo.png" alt="Google DeepMind Logo" class="logo">
                    <h1>Authentication Successful!</h1>
                    <p>Your account for WhatsApp user <span class="user-id">${senderId}</span> has been successfully linked with Google Tasks.</p>
                    <p class="footer">You can now close this page and return to WhatsApp.</p>
                </div>
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

    // 1. Basic Validation: Ensure a sender ID is present.
    if (!senderId) {
        console.error('index.ts: Critical - Missing senderId (From) in webhook request. Cannot process.');
        res.status(400).send('Sender ID missing.');
        return;
    }
    console.log(`index.ts: Processing request for sender [${senderId}], Number of media items: ${numMedia}`);

    // 2. Media Message Handling
    if (numMedia > 0) {
        console.log(`index.ts: Detected [${numMedia}] media item(s) from sender [${senderId}].`);
        if (numMedia > 1) {
            console.warn(`index.ts: User [${senderId}] sent ${numMedia} media files. Responding with an error message.`);
            twiml.message(MEDIA_MESSAGES.ERROR_MULTIPLE_MEDIA);
            res.type('text/xml').send(twiml.toString());
            return;
        } else {
            // Handle single media file
            const mediaUrl = req.body.MediaUrl0 as string | undefined;
            const mediaContentType = req.body.MediaContentType0 as string | undefined;
            let localMediaFilePath: string | undefined; // To be accessible in the finally block for cleanup
            const userMessage = req.body.Body as string | undefined;

            try {
                if (!mediaUrl || !mediaContentType) {
                    throw new Error("Missing MediaUrl0 or MediaContentType0 in webhook payload.");
                }

                localMediaFilePath = await downloadAndSaveMediaFile(mediaUrl, mediaContentType, senderId);
                const userTextPrompt = userMessage?.trim() || ""; // Default to empty string if no text

                if (!userTextPrompt) {
                    // If the user sent media without text, store it and ask for a prompt.
                    pendingMedia[senderId] = { filePath: localMediaFilePath, mimeType: mediaContentType };
                    twiml.message(MEDIA_MESSAGES.PROMPT_FOR_MEDIA);
                } else {
                    // If text is present, process media and handle the response immediately.
                    const { responseText, googleSearchUsed } = await processMedia(localMediaFilePath, mediaContentType, senderId, userTextPrompt);
                    await handleGeminiResponse(responseText, googleSearchUsed, senderId, twiml);
                    // Since it's processed, ensure the file is cleaned up.
                    await fsPromises.unlink(localMediaFilePath).catch(err => console.error(`Failed to delete media file: ${err}`));
                    localMediaFilePath = undefined; // Prevent double deletion in finally
                }
            } catch (error: any) {
                console.error(`index.ts: Error processing media for [${senderId}]:`, error);
                twiml.message(MEDIA_MESSAGES.ERROR_RECEIVING_MEDIA);
            } finally {
                // The finally block now only handles the cleanup of files that were not
                // processed immediately (i.e., those pending a prompt).
                if (localMediaFilePath) {
                    try {
                        await fsPromises.unlink(localMediaFilePath);
                        console.log(`index.ts: Cleaned up media file [${localMediaFilePath}] that was pending a prompt.`);
                    } catch (cleanupError) {
                        console.error(`index.ts: Failed to clean up pending media file [${localMediaFilePath}].`, cleanupError);
                    }
                }
                res.type('text/xml').send(twiml.toString());
            }
            return;
        }
    }

    // 3. Text Message Handling
    const messageBody = req.body.Body as string | undefined;

    // Check for an empty message body, which can happen with some media types or client issues.
    if (!messageBody) {
        console.warn(`index.ts: Received empty message body from [${senderId}].`);
        twiml.message(GENERAL_MESSAGES.EMPTY_MESSAGE_BODY);
        res.type('text/xml').send(twiml.toString());
        return;
    }

    const normalizedMessage = messageBody.trim();
    const lcNormalizedMessage = normalizedMessage.toLowerCase();
    
    // --- User state checks ---
    // Check if the user is responding to a pending media prompt.
    if (pendingMedia[senderId]) {
        console.log(`index.ts: Detected pending media for user [${senderId}]. Processing with new prompt.`);
        const { filePath, mimeType } = pendingMedia[senderId];
        delete pendingMedia[senderId]; // Clear pending state
        
        try {
            const { responseText, googleSearchUsed } = await processMedia(filePath, mimeType, senderId, normalizedMessage);
            await handleGeminiResponse(responseText, googleSearchUsed, senderId, twiml);
        } catch (error) {
            console.error(`index.ts: Error processing pending media for [${senderId}]:`, error);
            twiml.message(MEDIA_MESSAGES.ERROR_PROCESSING_PENDING_MEDIA);
        } finally {
            // Always clean up the file after processing is complete or has failed.
            try {
                await fsPromises.unlink(filePath);
                console.log(`index.ts: Cleaned up pending media file [${filePath}].`);
            } catch (cleanupError) {
                console.error(`index.ts: Failed to clean up pending media file [${filePath}].`, cleanupError);
            }
            res.type('text/xml').send(twiml.toString());
        }
        return;
    }

    // Check if the user is responding to a task deletion prompt.
    if (pendingDeletion[senderId]) {
        const taskTitles = pendingDeletion[senderId];
        delete pendingDeletion[senderId]; // Consume the pending state
        
        const taskToMark = findTaskFromReply(normalizedMessage, taskTitles);
        if (taskToMark) {
            console.log(`index.ts: User [${senderId}] selected task "${taskToMark}" for deletion.`);
            const deletionResult = await deleteGoogleTask(senderId, taskToMark);
            twiml.message(deletionResult);
        } else {
            twiml.message(`I couldn't find a task matching your reply. Please try starting the deletion process again.`);
        }
        res.type('text/xml').send(twiml.toString());
        return;
    }
    
    // Check for new vs. returning users and send a welcome message if needed.
    const isNewUser = !(await isReturningUser(senderId));
    if (isNewUser) {
        sendWelcomeMessage(twiml);
        await addNewUser(senderId); // Mark them as a returning user for the future
        res.type('text/xml').send(twiml.toString());
        return;
    }
    
    // --- Command Handling ---
    if (normalizedMessage.startsWith('/')) {
        console.log(`index.ts: Detected command "${lcNormalizedMessage}" from [${senderId}].`);
        const isAuthenticated = await isUserAuthenticated(senderId);

        switch (lcNormalizedMessage) {
            case '/start':
            case '/help':
                sendWelcomeMessage(twiml);
                break;
            case '/connect_google_tasks':
                if (isAuthenticated) {
                    twiml.message(AUTH_MESSAGES.ALREADY_AUTHENTICATED);
                } else {
                    const authUrl = `${SERVER_BASE_URL}/auth/google/initiate?senderId=${encodeURIComponent(senderId)}`;
                    twiml.message(AUTH_MESSAGES.INITIATE_AUTH_INSTRUCTIONS.replace('{authUrl}', authUrl));
                }
                break;
            case '/disconnect_google_tasks':
                const cleared = await clearUserTokens(senderId);
                twiml.message(cleared ? AUTH_MESSAGES.DISCONNECT_SUCCESS : AUTH_MESSAGES.DISCONNECT_FAILURE);
                break;
            case '/status_google_tasks':
                const statusMessage = await getAuthStatus(senderId);
                twiml.message(statusMessage);
                break;
            case '/list_task_lists':
                if (!isAuthenticated) {
                    twiml.message(AUTH_MESSAGES.TASK_LISTING_AUTH_REQUIRED);
                    break;
                }
                const lists = await listTaskLists(senderId);
                if (typeof lists === 'string') {
                    twiml.message(lists);
                } else if (lists.length === 0) {
                    twiml.message("You have no Google Task lists.");
                } else {
                    const listNames = lists.map(list => `• ${list.title}`).join('\n');
                    twiml.message(`*Your Google Task Lists:*\n${listNames}`);
                }
                break;
            case '/get_tasks':
                if (!isAuthenticated) {
                    twiml.message(AUTH_MESSAGES.TASK_LISTING_AUTH_REQUIRED);
                    break;
                }
                const tasksString = await getFormattedTasksString(senderId);
                twiml.message(tasksString);
                break;
            default:
                twiml.message(INVALID_COMMAND_MESSAGE);
                break;
        }
    } else {
        // --- AI Chat & Task Management Logic ---
        console.log(`index.ts: No command detected. Treating as a general chat or task message from [${senderId}].`);
        const useSystemInstruction = isTaskManagementRequest(normalizedMessage);
        const { responseText, googleSearchUsed } = await generateGeminiChatResponse(ai, senderId, normalizedMessage, chatHistories, useSystemInstruction);

        await handleGeminiResponse(responseText, googleSearchUsed, senderId, twiml);
    }

    res.type('text/xml').send(twiml.toString());
});

// --- ERROR HANDLING & SERVER STARTUP ---

function errorHandler(err: Error, req: Request, res: Response, next: NextFunction) {
    console.error("--- UNHANDLED ERROR ---");
    console.error(err.stack);
    res.status(500).send('Something broke!');
}

// --- UTILITY FUNCTIONS ---

/**
 * A central function to handle the processing of any supported media type.
 * It determines the correct Gemini function to call based on the MIME type.
 * @param filePath The local path to the downloaded media file.
 * @param mimeType The MIME type of the file.
 * @param senderId The user's ID.
 * @param prompt The text prompt accompanying the media.
 * @returns A promise that resolves to the text response from Gemini.
 */
async function processMedia(filePath: string, mimeType: string, senderId: string, prompt: string): Promise<{responseText: string, googleSearchUsed: boolean}> {
    const useSystemInstruction = isTaskManagementRequest(prompt);
    
    if (mimeType.startsWith('audio/')) {
        const effectivePrompt = prompt.trim() === "" ? FIXED_TEXT_PROMPT_FOR_AUDIO : prompt;
        return await processAudioWithGemini(ai, senderId, filePath, mimeType, effectivePrompt, chatHistories, useSystemInstruction);
    } else if (mimeType.startsWith('image/')) {
        return await processImageWithGemini(ai, senderId, filePath, mimeType, prompt, chatHistories, useSystemInstruction);
    } else if (mimeType.startsWith('video/')) {
        return await processVideoWithGemini(ai, senderId, filePath, mimeType, prompt, chatHistories, useSystemInstruction);
    } else if (['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'].includes(mimeType)) {
        return await processDocumentWithGemini(ai, senderId, filePath, mimeType, prompt, chatHistories, useSystemInstruction);
    } else {
        console.warn(`index.ts: Unsupported media type [${mimeType}] passed to processMedia for [${senderId}].`);
        const errorText = MEDIA_MESSAGES.UNSUPPORTED_MEDIA_TYPE;
        return { responseText: errorText, googleSearchUsed: false };
    }
}

/**
 * Downloads a media file from a Twilio URL and saves it to a local temporary directory.
 * @param {string} mediaUrl The URL of the media file on Twilio's servers.
 * @param {string} mediaContentType The MIME type of the media.
 * @param {string} senderId The sender's ID, used for creating a unique filename.
 * @returns {Promise<string>} A promise that resolves with the local path to the saved file.
 */
async function downloadAndSaveMediaFile(mediaUrl: string, mediaContentType: string, senderId: string): Promise<string> {
    const fileExtension = mediaContentType.split('/')[1] || 'tmp';
    const localFilePath = path.join(mediaDir, `${senderId}-${Date.now()}.${fileExtension}`);
    
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
app.use(errorHandler);
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}.`);
    console.log(`Open ${SERVER_BASE_URL} to see the running application.`);
}); 