/**
 * @file index.ts
 * @description This is the main entry point for the IdeasReminder application.
 * It sets up an Express server to handle incoming WhatsApp messages via a Twilio webhook.
 * The server processes text, audio, and other media messages, interacts with the
 * Google Gemini API for conversational AI, and integrates with the Google Tasks API
 * for task management. It also handles the OAuth2 flow for Google API authentication.
 */

// --- IMPORTS ---
// For loading environment variables from a .env file
import * as dotenv from 'dotenv';
import express, { Request, Response, NextFunction } from 'express'; // Added NextFunction
// Twilio SDK for sending WhatsApp messages
import twilio from 'twilio';
// Google Generative AI SDK for interacting with Gemini
import { GoogleGenAI } from "@google/genai";
// Import Gemini utility functions with new English names
import {
    generateGeminiChatResponse,
    processAudioWithGemini,
    processImageWithGemini,
    processVideoWithGemini,
    processDocumentWithGemini
} from './components/gemini';
// Import Google Tasks utility functions
import {
    initiateGoogleAuth,
    handleGoogleAuthCallback,
    isUserAuthenticated,
    clearUserTokens,
    getAuthStatus,
    listTaskLists,
    getTasksInList,
    createGoogleTask
} from './components/gtasks';
// Import chat history types with new English names
import { ChatHistories } from './types/chat'; 
import axios from 'axios'; // For downloading audio
import fs from 'fs';       // For saving files (sync operations like existsSync, mkdirSync, createWriteStream)
import fsPromises from 'fs/promises'; // For async file operations like unlink
import path from 'path';   // For path manipulation
import os from 'os';       // For temporary directory

// --- DOTENV CONFIGURATION ---
// Load environment variables from .env file into process.env
// It's crucial to call this at the very beginning of the application
dotenv.config();
console.log('index.ts: Environment variables loaded.');

// --- ENVIRONMENT VARIABLE RETRIEVAL AND VALIDATION ---
// This section retrieves all necessary environment variables
// and exits the application if any are missing, providing clear error messages.
console.log('index.ts: Validating environment variables...');
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const FROM_NUMBER = process.env.FROM_NUMBER; // Correctly use FROM_NUMBER as specified
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PORT = process.env.PORT || '3000'; // Default to port 3000 if not specified
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;

if (!TWILIO_ACCOUNT_SID) {
    console.error('index.ts: FATAL ERROR - TWILIO_ACCOUNT_SID is not set. Application will exit.');
    process.exit(1);
}
if (!TWILIO_AUTH_TOKEN) {
    console.error('index.ts: FATAL ERROR - TWILIO_AUTH_TOKEN is not set. Application will exit.');
    process.exit(1);
}
if (!FROM_NUMBER) {
    console.error('index.ts: FATAL ERROR - FROM_NUMBER is not set. This is required for sending proactive messages. Application will exit.');
    process.exit(1);
}
if (!GEMINI_API_KEY) {
    console.error('index.ts: FATAL ERROR - GEMINI_API_KEY is not set. Application will exit.');
    process.exit(1);
}
if (!GOOGLE_CLIENT_ID) {
    console.error('index.ts: FATAL ERROR - GOOGLE_CLIENT_ID is not set. Application will exit.');
    process.exit(1);
}
if (!GOOGLE_CLIENT_SECRET) {
    console.error('index.ts: FATAL ERROR - GOOGLE_CLIENT_SECRET is not set. Application will exit.');
    process.exit(1);
}
if (!GOOGLE_REDIRECT_URI) {
    console.error('index.ts: FATAL ERROR - GOOGLE_REDIRECT_URI is not set. Application will exit.');
    process.exit(1);
}
console.log('index.ts: Environment variables validated successfully.');

// --- DYNAMIC SERVER BASE URL ---
// This logic derives the server's public-facing base URL from the GOOGLE_REDIRECT_URI.
// This is crucial for ensuring that links sent to users (like for OAuth) use the correct public URL (e.g., from ngrok).
let SERVER_BASE_URL: string;
try {
    // We assume GOOGLE_REDIRECT_URI is something like 'https://[your-ngrok-url]/auth/google/callback'
    // The .origin property will correctly extract 'https://[your-ngrok-url]'
    const redirectUrl = new URL(GOOGLE_REDIRECT_URI!);
    SERVER_BASE_URL = redirectUrl.origin;
    console.log(`index.ts: SERVER_BASE_URL dynamically set from GOOGLE_REDIRECT_URI: ${SERVER_BASE_URL}`);
} catch (error) {
    console.error('index.ts: Invalid GOOGLE_REDIRECT_URI format. Could not parse to determine SERVER_BASE_URL.');
    console.error('index.ts: Please ensure GOOGLE_REDIRECT_URI is a full, valid URL (e.g., "https://example.com/callback").');
    // Fallback or exit if this is critical
    console.log(`index.ts: Falling back to default SERVER_BASE_URL: http://localhost:${PORT}`);
    SERVER_BASE_URL = `http://localhost:${PORT}`;
}

// --- TWILIO CLIENT INITIALIZATION ---
// Initialize the main Twilio client for sending proactive messages
console.log('index.ts: Initializing Twilio client...');
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
console.log('index.ts: Twilio client initialized successfully.');

// --- GEMINI API CLIENT INITIALIZATION ---
console.log('index.ts: Initializing GoogleGenAI client...');
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
console.log('index.ts: GoogleGenAI client initialized successfully.');

// --- CHAT HISTORY STORE (IN-MEMORY) ---
// WARNING: This in-memory storage will be lost if the server restarts.
// For production, consider a persistent database (e.g., Redis, Firestore).
const chatHistories: ChatHistories = {};
console.log('index.ts: In-memory chat history store initialized.');

// --- EXPRESS SERVER SETUP ---
const app = express();

// Middleware to parse URL-encoded data (typically from webhooks like Twilio)
app.use(express.urlencoded({ extended: true }));
// Middleware to parse JSON data in request bodies
app.use(express.json());

console.log('index.ts: Express server configured with middleware.');

// --- HELPER FUNCTION TO DOWNLOAD AND SAVE MEDIA ---
async function downloadAndSaveMediaFile(mediaUrl: string, contentType: string, senderId: string): Promise<string> {
    console.log(`index.ts: Attempting to download media from ${mediaUrl} (type: ${contentType}) for sender [${senderId}]`);
    let localFilePath: string | undefined;
    try {
        const response = await axios({
            method: 'get',
            url: mediaUrl,
            responseType: 'stream',
        });

        const fileExtension = contentType.split('/')[1] || 'tmp'; // Generalize extension
        const tempDir = path.join(os.tmpdir(), 'voicetasks_media'); // Generalize temp directory
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
            console.log(`index.ts: Created temporary directory for media files: ${tempDir}`);
        }
        // Generalize filename
        const uniqueFilename = `media_${senderId.replace(/[^a-zA-Z0-9]/g, '')}_${Date.now()}.${fileExtension}`;
        localFilePath = path.join(tempDir, uniqueFilename);

        const writer = fs.createWriteStream(localFilePath);
        response.data.pipe(writer);

        return new Promise((resolve, reject) => {
            writer.on('finish', () => {
                console.log(`index.ts: Media file successfully downloaded and saved to ${localFilePath} for [${senderId}]`);
                resolve(localFilePath!);
            });
            writer.on('error', async (err) => {
                console.error(`index.ts: Error writing media file to ${localFilePath} for [${senderId}]:`, err);
                if (localFilePath) {
                    try {
                        await fsPromises.unlink(localFilePath);
                        console.log(`index.ts: Partially written media file ${localFilePath} was deleted.`);
                    } catch (unlinkErr) {
                        console.error(`index.ts: Failed to delete partially written media file ${localFilePath}:`, unlinkErr);
                    }
                }
                reject(err);
            });
        });
    } catch (error) {
        console.error(`index.ts: Error downloading media from ${mediaUrl} for [${senderId}]:`, error);
        throw error;
    }
}

// --- TWILIO WEBHOOK ENDPOINT ---
// Twilio sends POST requests to this endpoint when a message is received on your Twilio number
const FIXED_TEXT_PROMPT_FOR_AUDIO = "Answer the question in the audio."; // Renamed for clarity
const FIXED_TEXT_PROMPT_FOR_IMAGE = "Describe this image and answer any question it might contain.";
const FIXED_TEXT_PROMPT_FOR_VIDEO = "Summarize this video and answer any question it might contain.";
const FIXED_TEXT_PROMPT_FOR_DOCUMENT = "Summarize this document and answer any question it might contain.";

// --- GOOGLE AUTH ROUTES ---
// Route to initiate Google OAuth flow
app.get('/auth/google/initiate', (req: Request, res: Response) => {
    const senderId = req.query.senderId as string;
    if (!senderId) {
        console.error("index.ts: /auth/google/initiate called without a senderId.");
        return res.status(400).send('Authentication failed: Missing user identifier.');
    }
    // This function is synchronous, so no need for async/await or try/catch here.
    const authUrl = initiateGoogleAuth(senderId);
    res.redirect(authUrl);
});

// Callback route for Google OAuth
app.get('/auth/google/callback', async (req: Request, res: Response) => {
    const { code, state: senderId, error: errorQueryParam } = req.query;

    if (errorQueryParam) {
        console.error(`index.ts: /auth/google/callback error from Google: ${errorQueryParam} for senderId [${senderId}].`);
        return res.status(400).send(`<html><body><h1>Authentication Failed</h1><p>Google authentication failed: ${errorQueryParam}. You can close this page.</p></body></html>`);
    }

    if (!code || typeof code !== 'string' || !senderId || typeof senderId !== 'string') {
        console.error("index.ts: /auth/google/callback called with missing code or state.", { query: req.query });
        return res.status(400).send('Authentication failed: Missing authorization code or user identifier.');
    }

    try {
        await handleGoogleAuthCallback(code, senderId);
        
        // --- Send proactive success message to user on WhatsApp ---
        console.log(`index.ts: Attempting to send proactive auth success message to [${senderId}].`);
        try {
            await twilioClient.messages.create({
                body: '✅ Authentication with Google Tasks was successful! You can now use task-related commands.',
                from: FROM_NUMBER!,
                to: senderId
            });
            console.log(`index.ts: Proactive message sent successfully to [${senderId}].`);
        } catch (twilioError) {
            console.error(`index.ts: FAILED to send proactive success message to [${senderId}].`, twilioError);
        }
        
        // --- Display a user-friendly success page in the browser ---
        res.send(`
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
        console.error(`index.ts: Error during Google OAuth callback for sender [${senderId}]:`, error);
        res.status(500).send('<html><body><h1>Authentication Error</h1><p>An error occurred while authenticating with Google. Please try again. You can close this page.</p></body></html>');
    }
});

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
            twiml.message("Please send only one media file at a time.");
        } else {
            const mediaUrl = req.body.MediaUrl0 as string | undefined;
            const mediaContentType = req.body.MediaContentType0 as string | undefined;
            let localMediaFilePath: string | undefined; // To be accessible in the finally block for cleanup
            let geminiMediaResponse: string | undefined;
            const userMessage = req.body.Body as string | undefined; // Corrected variable name

            if (!mediaUrl || !mediaContentType) {
                console.error(`index.ts: Missing MediaUrl0 or MediaContentType0 for media message from [${senderId}].`);
                twiml.message("There was an issue receiving your media file. Please try again.");
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

                    if (supportedAudioTypes.includes(mediaContentType)) {
                        effectivePrompt = (userMessage && userMessage.trim() !== "") ? userMessage : FIXED_TEXT_PROMPT_FOR_AUDIO;
                        console.log(`index.ts: Processing downloaded audio for [${senderId}]. Prompt: "${effectivePrompt}"`);
                        geminiMediaResponse = await processAudioWithGemini(ai, senderId, localMediaFilePath, mediaContentType, effectivePrompt, chatHistories);
                    } else if (supportedImageTypes.includes(mediaContentType)) {
                        effectivePrompt = (userMessage && userMessage.trim() !== "") ? userMessage : FIXED_TEXT_PROMPT_FOR_IMAGE;
                        console.log(`index.ts: Processing downloaded image for [${senderId}]. Prompt: "${effectivePrompt}"`);
                        geminiMediaResponse = await processImageWithGemini(ai, senderId, localMediaFilePath, mediaContentType, effectivePrompt, chatHistories);
                    } else if (supportedVideoTypes.includes(mediaContentType)) {
                        effectivePrompt = (userMessage && userMessage.trim() !== "") ? userMessage : FIXED_TEXT_PROMPT_FOR_VIDEO;
                        console.log(`index.ts: Processing downloaded video for [${senderId}]. Prompt: "${effectivePrompt}"`);
                        geminiMediaResponse = await processVideoWithGemini(ai, senderId, localMediaFilePath, mediaContentType, effectivePrompt, chatHistories);
                    } else if (supportedDocumentTypes.includes(mediaContentType)) {
                        effectivePrompt = (userMessage && userMessage.trim() !== "") ? userMessage : FIXED_TEXT_PROMPT_FOR_DOCUMENT;
                        console.log(`index.ts: Processing downloaded document for [${senderId}]. Prompt: "${effectivePrompt}"`);
                        geminiMediaResponse = await processDocumentWithGemini(ai, senderId, localMediaFilePath, mediaContentType, effectivePrompt, chatHistories);
                    } else {
                        console.warn(`index.ts: User [${senderId}] sent an unsupported media file type: ${mediaContentType}.`);
                        twiml.message("The media file type you sent is not currently supported. Please try an image, audio, video, or a common document format (PDF, DOCX, PPTX, XLSX).");
                    }

                    if (geminiMediaResponse === undefined && !twiml.response.children.length) {
                        geminiMediaResponse = "I received your media, but I couldn't formulate a response right now. Please try again.";
                        console.warn(`index.ts: Gemini media processing for a supported type returned an empty/undefined response for [${senderId}]. Using fallback message.`);
                    }
                    
                    if (geminiMediaResponse && !twiml.response.children.length) { // Only add message if not already set (e.g., by unsupported type)
                        twiml.message(geminiMediaResponse);
                    }
                    
                    if (geminiMediaResponse) {
                         console.log(`index.ts: Media processing by Gemini complete for [${senderId}]. Response prepared: "${geminiMediaResponse}"`);
                    }

                } catch (error) {
                    console.error(`index.ts: Error processing media message for [${senderId}]:`, error);
                    twiml.message("Sorry, I encountered an error trying to understand your media message. Please try again later.");
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
            twiml.message("Thanks for your message! If you meant to send text, please try again, or send an audio message.");
        } else {
            // Normalize message for easier command parsing
            const lowerCaseMsg = incomingMsg.toLowerCase().trim();

            if (lowerCaseMsg === '/connect_google_tasks') {
                console.log(`index.ts: Received /connect_google_tasks command from [${senderId}].`);
                
                if (isUserAuthenticated(senderId)) {
                    console.log(`index.ts: User [${senderId}] is already authenticated. Informing the user.`);
                    twiml.message("You are already connected to Google Tasks. You can start using commands like '/list_task_lists'.\n\nIf you want to connect a different account, first disconnect the current one using the command: /disconnect_google_tasks");
                } else {
                    console.log(`index.ts: User [${senderId}] is not authenticated. Generating auth URL.`);
                    const initiationUrl = `${SERVER_BASE_URL}/auth/google/initiate?senderId=${encodeURIComponent(senderId)}`;
                    
                    console.log(`index.ts: Sending rich auth initiation message to [${senderId}].`);
                    twiml.message("To connect your Google Tasks account, please open this link in your browser:");
                    twiml.message(initiationUrl);
                    twiml.message("After authorizing, you can use commands like '/list_task_lists'.");
                }
            
            } else if (lowerCaseMsg === '/disconnect_google_tasks') {
                console.log(`index.ts: Received /disconnect_google_tasks command from [${senderId}].`);
                const cleared = clearUserTokens(senderId);
                if (cleared) {
                    twiml.message('Your Google Tasks account has been disconnected. Your tokens have been cleared.');
                } else {
                    twiml.message('No active Google Tasks connection found to disconnect.');
                }
            
            } else if (lowerCaseMsg === '/status_google_tasks') {
                console.log(`index.ts: Received /status_google_tasks command from [${senderId}].`);
                const statusMessage = getAuthStatus(senderId);
                twiml.message(statusMessage);

            } else if (lowerCaseMsg === '/list_task_lists') {
                console.log(`index.ts: Received /list_task_lists command from [${senderId}].`);
                const taskListsResponse = await listTaskLists(senderId);
                if (typeof taskListsResponse === 'string') {
                    twiml.message(taskListsResponse);
                } else if (!taskListsResponse || taskListsResponse.length === 0) {
                    twiml.message('You have no Google Task lists, or I couldn\'t find them. Ensure you are connected with /connect_google_tasks.');
                } else {
                    let message = 'Your Google Task Lists:\n';
                    taskListsResponse.forEach(list => {
                        message += `- ${list.title} (ID: ${list.id || 'N/A'})\n`;
                    });
                    message += '\nTo see tasks in a list, use: /show_tasks <list_ID_or_title>';
                    twiml.message(message.trim());
                }
            
            } else if (lowerCaseMsg.startsWith('/show_tasks')) {
                const parts = incomingMsg.trim().split(' ');
                const taskListIdentifier = parts.length > 1 ? parts.slice(1).join(' ') : '@default';
                console.log(`index.ts: Received /show_tasks command for list [${taskListIdentifier}] from [${senderId}].`);
                
                const tasksResponse = await getTasksInList(senderId, taskListIdentifier);
                if (typeof tasksResponse === 'string') {
                    twiml.message(tasksResponse);
                } else if (!tasksResponse || tasksResponse.length === 0) {
                    twiml.message(`No tasks found in list "${taskListIdentifier === '@default' ? 'Default List' : taskListIdentifier}".`);
                } else {
                    let message = `Tasks in "${taskListIdentifier === '@default' ? 'Default List' : taskListIdentifier}":\n`;
                    tasksResponse.forEach(task => {
                        message += `- ${task.title}${task.notes ? ` (Notes: ${task.notes})` : ''}${task.status === 'completed' ? ' [DONE]' : ''}\n`;
                    });
                    twiml.message(message.trim());
                }

            } else if (lowerCaseMsg.startsWith('/add_task')) {
                const commandParts = incomingMsg.trim().split(' ');
                const taskTitle = commandParts.slice(1).join(' ').trim();
                const taskListId = '@default'; // Add to the default list by default.

                console.log(`index.ts: Received /add_task command with title "${taskTitle}" for list [${taskListId}] from [${senderId}].`);
                if (!taskTitle) {
                    twiml.message('Please provide a title for the task. Usage: /add_task Your task title here');
                } else {
                    const creationResponse = await createGoogleTask(senderId, taskTitle, taskListId);
                    if (typeof creationResponse === 'string') {
                        twiml.message(creationResponse);
                    } else {
                        twiml.message(`Task "${creationResponse.title}" created successfully in your default Google Tasks list!`);
                    }
                }
            } else {
                // If the message starts with '/' it's an attempt at a command that we don't recognize.
                if (incomingMsg.trim().startsWith('/')) {
                    const commandList = `
Invalid command. Please use one of the available commands:

• */connect_google_tasks* - Connect your Google Tasks account.
• */disconnect_google_tasks* - Disconnect your Google Tasks account.
• */status_google_tasks* - Check the status and expiry of your connection.
• */list_task_lists* - Show all your task lists.
• */show_tasks <list_name>* - Show tasks from a specific list (use "@default" for the default list).
• */add_task <task_description>* - Add a new task to your default list.

Any other message (not starting with /) will be treated as a conversation with the AI.
                    `.trim().replace(/^ +/gm, ''); // Trim and remove leading spaces from each line

                    twiml.message(commandList);
                } else {
                    // Default to Gemini chat if no command recognized and doesn't start with /
                    console.log(`index.ts: No command recognized. Passing to Gemini for sender [${senderId}].`);
                    let geminiResponseText = await generateGeminiChatResponse(ai, senderId, incomingMsg, chatHistories);
                    console.log(`index.ts: Gemini chat response for [${senderId}]: "${geminiResponseText}"`);
                    if (!geminiResponseText) {
                        geminiResponseText = "I'm having a little trouble thinking right now. Please try again in a moment!";
                        console.warn(`index.ts: Gemini chat returned an empty response for [${senderId}]. Using fallback message.`);
                    }
                    twiml.message(geminiResponseText);
                }
            }
        }
    }

    console.log(`index.ts: Sending final TwiML response to [${senderId}].`);
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(twiml.toString());
});

// --- START EXPRESS SERVER ---
app.listen(PORT, () => {
    console.log(`index.ts: Express server started and listening on port ${PORT}.`);
    console.log(`index.ts: Twilio webhook endpoint available at /webhook/twilio`);
    console.log(`index.ts: Google OAuth initiation route available at ${SERVER_BASE_URL}/auth/google/initiate?senderId=YOUR_SENDER_ID`);
    console.log(`index.ts: Google OAuth callback configured for ${GOOGLE_REDIRECT_URI}`);
}); 