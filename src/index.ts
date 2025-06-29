/**
 * @file index.ts
 * @description This is the main entry point for the VoiceTasks application. It sets up an
 * Express server that listens for incoming WhatsApp messages via a Twilio webhook. The server
 * handles user authentication, processes text and media messages using the Google Gemini API,
 * manages chat state, and integrates with the Google Tasks API to create, list, and delete tasks.
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
import * as Prompts from './components/prompts';
import * as Gemini from './components/gemini';
import * as GAuth from './components/gauth';
import * as GTasks from './components/gtasks';
import * as Firestore from './components/firestore';

// =================================================================================================
// ==                                     INITIAL SETUP                                           ==
// =================================================================================================

dotenv.config();

// --- Environment Variable Validation ---
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

// --- Server and Client Initialization ---
let SERVER_BASE_URL: string;
try {
    const redirectUri = new URL(GOOGLE_REDIRECT_URI!);
    SERVER_BASE_URL = redirectUri.origin;
} catch (error) {
    console.error('FATAL ERROR: GOOGLE_REDIRECT_URI is not a valid URL. Please check your .env file.');
    process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY! });
const mediaDir = path.join('/tmp', 'media');
if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });

// =================================================================================================
// ==                                     STATE MANAGEMENT                                        ==
// =================================================================================================

// In-memory stores for chat histories and pending user states.
// For a production environment, this state would ideally be moved to a more persistent
// store like Redis or Firestore to handle server restarts and scaling.
const chatHistories: ChatHistories = {};
const pendingMedia: { [senderId: string]: { filePath: string; mimeType: string } } = {};
const pendingDeletion: { [senderId: string]: string[] } = {};

// =================================================================================================
// ==                                     HELPER FUNCTIONS                                        ==
// =================================================================================================

/**
 * A centralized function to process Gemini's response. It checks for actionable JSON
 * (for creating, listing, or deleting tasks) and handles it. Otherwise, it formats
 * the response as a standard chat message.
 * @param responseText The raw text response from the Gemini API.
 * @param googleSearchUsed A boolean indicating if Google Search was used by the model.
 * @param senderId The user's unique identifier.
 * @param twiml The Twilio TwiML response object to be populated.
 */
async function handleGeminiResponse(responseText: string, googleSearchUsed: boolean, senderId: string, twiml: twilio.twiml.MessagingResponse) {
    if (!responseText) {
        twiml.message(Prompts.GENERAL_MESSAGES.GEMINI_EMPTY_RESPONSE);
        return;
    }

    try {
        // Attempt to extract a JSON object from the model's response.
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            // If no JSON is found, it's a standard chat message.
            twiml.message(formatGeminiResponse(responseText, googleSearchUsed));
            return;
        }

        const parsedJson: IdentifiedTask = JSON.parse(jsonMatch[0]);
        const isAuthenticated = await GAuth.isUserAuthenticated(senderId);

        if (parsedJson.isTask) {
            // Handle Task Creation
            console.log(`index.ts: Gemini identified a task for creation from [${senderId}].`);
            if (!isAuthenticated) {
                twiml.message(Prompts.AUTH_MESSAGES.TASK_CREATION_AUTH_REQUIRED);
            } else {
                const tomorrow = getNextBusinessDay();
                const taskResult = await GTasks.createGoogleTask(senderId, {
                    title: parsedJson.details.objective,
                    description: `Description: ${parsedJson.details.description}\nFinal Result: ${parsedJson.details.final_result}\nUser Experience: ${parsedJson.details.user_experience}`,
                    dueDate: tomorrow.toISOString(),
                });
                if (typeof taskResult === 'string') {
                    twiml.message(taskResult);
                } else {
                    twiml.message(Prompts.TASK_MESSAGES.SUCCESS(taskResult.title || 'Untitled Task'));
                }
            }
        } else if (parsedJson.isTaskListRequest) {
            // Handle Task Listing
            console.log(`index.ts: Gemini identified a task listing request from [${senderId}].`);
            if (!isAuthenticated) {
                twiml.message(Prompts.AUTH_MESSAGES.TASK_LISTING_AUTH_REQUIRED);
            } else {
                const tasksString = await GTasks.getFormattedTasksString(senderId);
                twiml.message(tasksString);
            }
        } else if (parsedJson.isTaskDeletionRequest) {
            // Handle Task Deletion
            console.log(`index.ts: Gemini identified a task deletion request from [${senderId}].`);
            if (!isAuthenticated) {
                twiml.message(Prompts.AUTH_MESSAGES.TASK_DELETION_AUTH_REQUIRED);
            } else if (parsedJson.taskTitle) {
                // If the model extracted a title, delete it directly.
                const deletionResult = await GTasks.deleteGoogleTask(senderId, parsedJson.taskTitle);
                twiml.message(deletionResult);
            } else {
                // If no title was extracted, prompt the user to choose from a list.
                const taskTitles = await GTasks.getTaskTitles(senderId);
                if (taskTitles && taskTitles.length > 0) {
                    pendingDeletion[senderId] = taskTitles;
                    const numberedTasks = taskTitles.map((title, i) => `${i + 1}. ${title}`).join('\n');
                    twiml.message(`${Prompts.TASK_MESSAGES.DELETION_PROMPT}\n\n${numberedTasks}`);
                } else {
                    twiml.message(Prompts.TASK_MESSAGES.DELETION_NO_TASKS);
                }
            }
        } else {
            // The JSON was valid but didn't match any known action.
            console.warn(`index.ts: Received unexpected but valid JSON from Gemini for [${senderId}]. Treating as normal chat.`);
            twiml.message(formatGeminiResponse(responseText, googleSearchUsed));
        }
    } catch (e) {
        // If JSON parsing fails, it's a normal chat response.
        twiml.message(formatGeminiResponse(responseText, googleSearchUsed));
    }
}

/**
 * Calculates the date for the next business day (Monday-Friday).
 * @returns A Date object set to the beginning of the next business day.
 */
function getNextBusinessDay(): Date {
    const date = new Date();
    date.setHours(0, 0, 0, 0); // Start with a clean slate at midnight.
    const dayOfWeek = date.getDay(); // Sunday = 0, Monday = 1, ..., Saturday = 6

    if (dayOfWeek >= 1 && dayOfWeek <= 4) { // Monday to Thursday -> Tomorrow
        date.setDate(date.getDate() + 1);
    } else if (dayOfWeek === 5) { // Friday -> Monday
        date.setDate(date.getDate() + 3);
    } else if (dayOfWeek === 6) { // Saturday -> Monday
        date.setDate(date.getDate() + 2);
    } else { // Sunday (dayOfWeek === 0) -> Monday
        date.setDate(date.getDate() + 1);
    }
    return date;
}

/**
 * Formats a response from Gemini, adding a standard prefix.
 * @param text The raw text response from the model.
 * @param withGoogleSearch Indicates if Google Search was used.
 * @returns The formatted response string.
 */
const formatGeminiResponse = (text: string, withGoogleSearch: boolean = false): string => {
    const trimmedText = text.trim().replace(/^"|"$/g, '');
    const prefix = withGoogleSearch ? "*Gemini* ✨ (with Google Search):" : "*Gemini* ✨:";
    return `${prefix} ${trimmedText}`;
};

/**
 * Determines if a user's message is likely a request to manage tasks.
 * This acts as a gateway to decide whether to use the specialized system instruction for Gemini.
 * @param message The user's text message.
 * @returns True if the message contains task-related keywords.
 */
function isTaskManagementRequest(message: string): boolean {
    const taskKeywords = [
        'task', 'reminder', 'remind me', 'create', 'tarefa', 'lembrete', 'criar', // Creation
        'list', 'show', 'what are my', 'see my', 'listar', 'mostrar', 'quais são', // Listing
        'delete', 'remove', 'complete', 'deletar', 'remover', 'excluir', 'completar' // Deletion
    ];
    const lowerCaseMessage = message.toLowerCase();
    return taskKeywords.some(keyword => lowerCaseMessage.includes(keyword));
}

/**
 * Finds a task title from a user's reply, matching by full title or list position.
 * @param reply The user's text message reply.
 * @param taskTitles The list of task titles that were presented to the user.
 * @returns The matched task title, or null if no match is found.
 */
function findTaskFromReply(reply: string, taskTitles: string[]): string | null {
    const normalizedReply = reply.trim().toLowerCase();

    // 1. Direct match (case-insensitive)
    for (const title of taskTitles) {
        if (title.trim().toLowerCase() === normalizedReply) return title;
    }

    // 2. Positional match (e.g., "2", "the 2nd one")
    const numericMatch = normalizedReply.match(/\d+/);
    if (numericMatch) {
        const position = parseInt(numericMatch[0], 10);
        if (position > 0 && position <= taskTitles.length) {
            return taskTitles[position - 1]; // Array is 0-indexed.
        }
    }

    return null;
}

/**
 * Sends a pre-formatted welcome message to the user.
 * @param twiml The Twilio TwiML response object.
 */
const sendWelcomeMessage = (twiml: twilio.twiml.MessagingResponse) => {
    twiml.message(Prompts.WELCOME_MESSAGE);
};

// =================================================================================================
// ==                                     GOOGLE AUTH ROUTES                                      ==
// =================================================================================================

/**
 * A central function to handle the processing of any supported media type.
 * It determines the correct Gemini function to call based on the MIME type.
 * @param filePath The local path to the downloaded media file.
 * @param mimeType The MIME type of the file.
 * @param senderId The user's ID.
 * @param prompt The text prompt accompanying the media.
 * @returns A promise that resolves to the standardized response object from Gemini.
 */
async function processMedia(filePath: string, mimeType: string, senderId: string, prompt: string): Promise<{responseText: string, googleSearchUsed: boolean}> {
    const useSystemInstruction = isTaskManagementRequest(prompt);
    
    if (mimeType.startsWith('audio/')) {
        const effectivePrompt = prompt.trim() === "" ? Prompts.FIXED_TEXT_PROMPT_FOR_AUDIO : prompt;
        return await Gemini.processAudioWithGemini(ai, senderId, filePath, mimeType, effectivePrompt, chatHistories, useSystemInstruction);
    } else if (mimeType.startsWith('image/')) {
        return await Gemini.processImageWithGemini(ai, senderId, filePath, mimeType, prompt, chatHistories, useSystemInstruction);
    } else if (mimeType.startsWith('video/')) {
        return await Gemini.processVideoWithGemini(ai, senderId, filePath, mimeType, prompt, chatHistories, useSystemInstruction);
    } else if (['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'].includes(mimeType)) {
        return await Gemini.processDocumentWithGemini(ai, senderId, filePath, mimeType, prompt, chatHistories, useSystemInstruction);
    } else {
        console.warn(`index.ts: Unsupported media type [${mimeType}] passed to processMedia for [${senderId}].`);
        return { responseText: Prompts.MEDIA_MESSAGES.UNSUPPORTED_MEDIA_TYPE, googleSearchUsed: false };
    }
}

/**
 * Downloads a media file from a Twilio URL and saves it to a local temporary directory.
 * @param mediaUrl The URL of the media file on Twilio's servers.
 * @param mediaContentType The MIME type of the media.
 * @param senderId The sender's ID, used for creating a unique filename.
 * @returns A promise that resolves with the local path to the saved file.
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

// =================================================================================================
// ==                                       WEBHOOK & SERVER                                      ==
// =================================================================================================

app.get('/auth/google/initiate', (req: Request, res: Response, next: NextFunction) => {
    try {
        const senderId = req.query.senderId as string;
        if (!senderId) {
            return res.status(400).send('Authentication failed: Missing user identifier.');
        }
        const authUrl = GAuth.initiateGoogleAuth(senderId);
        return res.redirect(authUrl);
    } catch (error) {
        return next(error);
    }
});

app.get('/auth/google/callback', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { code, state: senderId, error: errorQueryParam } = req.query;

        // Handle the case where the user denies the OAuth request.
        if (errorQueryParam) {
            return res.status(400).send(`
                <!DOCTYPE html>
                <html lang="en">
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>Authentication Failed</title>
                    <style>
                        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background-color: #f0f2f5; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; color: #333; }
                        .container { text-align: center; background-color: #ffffff; padding: 40px; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); max-width: 500px; width: 90%; }
                        .logo { width: 200px; margin-bottom: 24px; }
                        h1 { font-size: 24px; color: #EA4335; margin-bottom: 16px; } /* Google Red */
                        p { font-size: 16px; line-height: 1.6; }
                        .footer { margin-top: 24px; font-size: 14px; color: #888; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <img src="https://upload.wikimedia.org/wikipedia/commons/5/56/Google_DeepMind_logo.png" alt="Google DeepMind Logo" class="logo">
                        <h1>Authentication Failed</h1>
                        <p>An error occurred: <strong>${errorQueryParam}</strong></p>
                        <p class="footer">You can close this page and try again from WhatsApp.</p>
                    </div>
                </body>
                </html>
            `);
        }
        
        if (!code || typeof code !== 'string' || !senderId || typeof senderId !== 'string') {
            return res.status(400).send('Authentication failed: Invalid request parameters.');
        }

        // Exchange the code for tokens and save them.
        await GAuth.handleGoogleAuthCallback(code, senderId);
        
        // Proactively notify the user in WhatsApp that the connection was successful.
        try {
            await twilioClient.messages.create({
                body: Prompts.AUTH_MESSAGES.AUTH_SUCCESS_PROACTIVE_MESSAGE,
                from: FROM_NUMBER!,
                to: senderId
            });
        } catch (twilioError) {
            console.error(`index.ts: FAILED to send proactive success message to [${senderId}].`, twilioError);
        }
        
        // Display a success page to the user in their browser.
        return res.send(`
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Authentication Successful</title>
                <style>
                    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background-color: #f0f2f5; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; color: #333; }
                    .container { text-align: center; background-color: #ffffff; padding: 40px; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); max-width: 500px; width: 90%; }
                    .logo { width: 200px; margin-bottom: 24px; }
                    h1 { font-size: 24px; color: #4285F4; margin-bottom: 16px; } /* Google Blue */
                    p { font-size: 16px; line-height: 1.6; }
                    .footer { margin-top: 24px; font-size: 14px; color: #888; }
                </style>
            </head>
            <body>
                <div class="container">
                    <img src="https://upload.wikimedia.org/wikipedia/commons/5/56/Google_DeepMind_logo.png" alt="Google DeepMind Logo" class="logo">
                    <h1>Authentication Successful!</h1>
                    <p>Your account has been successfully linked with Google Tasks.</p>
                    <p class="footer">You can now close this page and return to WhatsApp.</p>
                </div>
            </body>
            </html>
        `);
    } catch (error) {
        return next(error);
    }
});

/**
 * Main webhook to handle all incoming WhatsApp messages from Twilio.
 */
app.post('/webhook/twilio', async (req: Request, res: Response) => {
    const { MessagingResponse } = twilio.twiml;
    const twiml = new MessagingResponse();
    const senderId = req.body.From as string;

    // 1. Basic Validation
    if (!senderId) {
        console.error('index.ts: Critical - Missing senderId (From) in webhook request. Cannot process.');
        res.status(400).send('Sender ID missing.');
        return;
    }
    console.log(`index.ts: Processing request for sender [${senderId}].`);

    // 2. Media Message Handling (Images, Audio, etc.)
    const numMedia = parseInt(req.body.NumMedia || '0', 10);
    if (numMedia > 0) {
        if (numMedia > 1) {
            twiml.message(Prompts.MEDIA_MESSAGES.ERROR_MULTIPLE_MEDIA);
        } else {
            const mediaUrl = req.body.MediaUrl0 as string;
            const mediaContentType = req.body.MediaContentType0 as string;
            const userTextPrompt = (req.body.Body as string)?.trim() || "";
            let localMediaFilePath: string | undefined;

            try {
                localMediaFilePath = await downloadAndSaveMediaFile(mediaUrl, mediaContentType, senderId);
                
                if (!userTextPrompt) {
                    // If no text, store the file and ask the user for instructions.
                    pendingMedia[senderId] = { filePath: localMediaFilePath, mimeType: mediaContentType };
                    twiml.message(Prompts.MEDIA_MESSAGES.PROMPT_FOR_MEDIA);
                } else {
                    // If text is present, process immediately.
                    const { responseText, googleSearchUsed } = await processMedia(localMediaFilePath, mediaContentType, senderId, userTextPrompt);
                    await handleGeminiResponse(responseText, googleSearchUsed, senderId, twiml);
                    await fsPromises.unlink(localMediaFilePath); // Cleanup processed file.
                    localMediaFilePath = undefined; // Prevent double deletion in finally.
                }
            } catch (error: any) {
                console.error(`index.ts: Error processing media for [${senderId}]:`, error);
                twiml.message(Prompts.MEDIA_MESSAGES.ERROR_RECEIVING_MEDIA);
                if (localMediaFilePath) {
                    await fsPromises.unlink(localMediaFilePath).catch(err => console.error(`Failed to delete media file: ${err}`));
                }
            }
        }
        res.type('text/xml').send(twiml.toString());
        return;
    }

    // 3. Text Message Handling
    const messageBody = (req.body.Body as string)?.trim();
    if (!messageBody) {
        twiml.message(Prompts.GENERAL_MESSAGES.EMPTY_MESSAGE_BODY);
        res.type('text/xml').send(twiml.toString());
        return;
    }
    
    // --- State-based Response Logic ---
    // A. User is responding to a "what to do with this file?" prompt.
    if (pendingMedia[senderId]) {
        const { filePath, mimeType } = pendingMedia[senderId];
        delete pendingMedia[senderId]; // Consume state
        
        try {
            const { responseText, googleSearchUsed } = await processMedia(filePath, mimeType, senderId, messageBody);
            await handleGeminiResponse(responseText, googleSearchUsed, senderId, twiml);
        } catch (error) {
            console.error(`index.ts: Error processing pending media for [${senderId}]:`, error);
            twiml.message(Prompts.MEDIA_MESSAGES.ERROR_PROCESSING_PENDING_MEDIA);
        } finally {
            await fsPromises.unlink(filePath).catch(err => console.error(`Failed to delete pending media file: ${err}`));
            res.type('text/xml').send(twiml.toString());
        }
        return;
    }

    // B. User is responding to a "which task to delete?" prompt.
    if (pendingDeletion[senderId]) {
        const taskTitles = pendingDeletion[senderId];
        delete pendingDeletion[senderId]; // Consume state
        
        const taskToMark = findTaskFromReply(messageBody, taskTitles);
        if (taskToMark) {
            const deletionResult = await GTasks.deleteGoogleTask(senderId, taskToMark);
            twiml.message(deletionResult);
        } else {
            twiml.message(`I couldn't find a task matching your reply. Please try starting the deletion process again.`);
        }
        res.type('text/xml').send(twiml.toString());
        return;
    }
    
    // C. New User Welcome.
    if (!(await Firestore.isReturningUser(senderId))) {
        sendWelcomeMessage(twiml);
        await Firestore.addNewUser(senderId);
        res.type('text/xml').send(twiml.toString());
        return;
    }
    
    // --- Standard Command and Chat Logic ---
    if (messageBody.startsWith('/')) {
        // Handle slash commands
        console.log(`index.ts: Detected command "${messageBody}" from [${senderId}].`);
        const isAuthenticated = await GAuth.isUserAuthenticated(senderId);

        switch (messageBody.toLowerCase()) {
            case '/start':
            case '/help':
                sendWelcomeMessage(twiml);
                break;
            case '/connect_google_tasks':
                if (isAuthenticated) {
                    twiml.message(Prompts.AUTH_MESSAGES.ALREADY_AUTHENTICATED);
                } else {
                    const authUrl = `${SERVER_BASE_URL}/auth/google/initiate?senderId=${encodeURIComponent(senderId)}`;
                    twiml.message(Prompts.AUTH_MESSAGES.INITIATE_AUTH_INSTRUCTIONS.replace('{authUrl}', authUrl));
                }
                break;
            case '/disconnect_google_tasks':
                const cleared = await GAuth.clearUserTokens(senderId);
                twiml.message(cleared ? Prompts.AUTH_MESSAGES.DISCONNECT_SUCCESS : Prompts.AUTH_MESSAGES.DISCONNECT_FAILURE);
                break;
            case '/status_google_tasks':
                const statusMessage = await GAuth.getAuthStatus(senderId);
                twiml.message(statusMessage);
                break;
            case '/get_tasks':
                if (!isAuthenticated) {
                    twiml.message(Prompts.AUTH_MESSAGES.TASK_LISTING_AUTH_REQUIRED);
                } else {
                    const tasksString = await GTasks.getFormattedTasksString(senderId);
                    twiml.message(tasksString);
                }
                break;
            default:
                twiml.message(Prompts.INVALID_COMMAND_MESSAGE);
                break;
        }
    } else {
        // Handle general AI chat or implicit task management
        const useSystemInstruction = isTaskManagementRequest(messageBody);
        const { responseText, googleSearchUsed } = await Gemini.generateGeminiChatResponse(ai, senderId, messageBody, chatHistories, useSystemInstruction);
        await handleGeminiResponse(responseText, googleSearchUsed, senderId, twiml);
    }

    res.type('text/xml').send(twiml.toString());
});

/**
 * Global error handler for the Express application.
 */
function errorHandler(err: Error, req: Request, res: Response, next: NextFunction) {
    console.error("--- UNHANDLED ERROR ---", err.stack);
    if (!res.headersSent) {
        res.status(500).send('Something broke!');
    }
}

app.use(errorHandler);

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}.`);
}); 