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
    processAudioWithGemini, 
    processImageWithGemini,
    processVideoWithGemini,
    processDocumentWithGemini,
    generateGeminiChatResponse,
    FIXED_TEXT_PROMPT_FOR_AUDIO,
    FIXED_TEXT_PROMPT_FOR_IMAGE,
    FIXED_TEXT_PROMPT_FOR_VIDEO,
    FIXED_TEXT_PROMPT_FOR_DOCUMENT
} from './components/gemini';
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
const mediaDir = path.join(__dirname, '..', 'media');
if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });

// --- WELCOME MESSAGE FUNCTION ---
/**
 * Sends a rich, formatted welcome message to the user.
 * @param {twilio.twiml.MessagingResponse} twiml The TwiML response object.
 */
const sendWelcomeMessage = (twiml: twilio.twiml.MessagingResponse) => {
    console.log("index.ts: Sending welcome message.");
    const welcomeText = `
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
    `.trim().replace(/^ +/gm, ''); // This ensures the formatting is neat in WhatsApp.

    twiml.message(welcomeText);
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
                body: '✅ Authentication with Google Tasks was successful! You can now use task-related commands.',
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

            // Check if it's the very first interaction for this user in this session.
            const isFirstInteraction = !chatHistories[senderId];
            if (isFirstInteraction) {
                console.log(`index.ts: First message received from [${senderId}]. Sending welcome message and initializing session.`);
                sendWelcomeMessage(twiml);
                chatHistories[senderId] = []; // Initialize session
                
                // End the interaction here to prevent Gemini from also responding to the "hello" message.
                res.writeHead(200, { 'Content-Type': 'text/xml' });
                res.end(twiml.toString());
                return;
            }

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

            } else if (lowerCaseMsg === '/help' || lowerCaseMsg === '/start') {
                console.log(`index.ts: Received /help or /start command from [${senderId}]. Resending welcome message.`);
                sendWelcomeMessage(twiml);
            } else {
                // If the message starts with '/' it's an attempt at a command that we don't recognize.
                if (incomingMsg.trim().startsWith('/')) {
                    const commandList = `
Invalid command. Please use one of the available commands:

• */connect_google_tasks* - Connect your Google Tasks account.
• */disconnect_google_tasks* - Disconnect your Google Tasks account.
• */status_google_tasks* - Check the status and expiry of your connection.
• */help* or */start* - Show this welcome message again.

Any other message (not starting with /) will be treated as a conversation with the AI.
                    `.trim().replace(/^ +/gm, ''); // Trim and remove leading spaces from each line

                    twiml.message(commandList);
                } else {
                    // This block is now only reached on the second and subsequent messages.
                    console.log(`index.ts: No command recognized. Passing to Gemini for sender [${senderId}].`);
                    const geminiResponseText = await generateGeminiChatResponse(ai, senderId, incomingMsg, chatHistories);
                    
                    console.log(`index.ts: Raw response from Gemini for [${senderId}]: "${geminiResponseText}"`);

                    try {
                        // Attempt to parse the response as JSON. If it's a task, it will be a valid JSON object.
                        // If it's a regular chat message, this will fail and we'll catch the error.
                        const parsedJson = JSON.parse(geminiResponseText);

                        // Check if the parsed object looks like our IdentifiedTask structure.
                        if (parsedJson && parsedJson.isTask === true && parsedJson.details) {
                            console.log(`index.ts: Gemini identified a task for [${senderId}].`);
                            const taskDetails = (parsedJson as IdentifiedTask).details;

                            // Check if user is authenticated with Google before proceeding.
                            if (!isUserAuthenticated(senderId)) {
                                console.log(`index.ts: User [${senderId}] tried to create a task but is not authenticated.`);
                                twiml.message("I've structured your task, but you need to connect your Google account first. Please use the command `/connect_google_tasks` and then send your task request again.");
                            } else {
                                console.log(`index.ts: Creating Google Task for [${senderId}].`);
                                const creationResponse = await createGoogleTask(senderId, taskDetails);

                                if (typeof creationResponse === 'string') {
                                    // If createGoogleTask returned an error message string
                                    twiml.message(creationResponse);
                                } else {
                                    // Success!
                                    const successMessage = `✅ Task created successfully!\n\n*${creationResponse.title}* has been added to your Google Tasks and is scheduled for tomorrow at 9 AM.`;
                                    twiml.message(successMessage);
                                    console.log(`index.ts: Successfully created task titled "${creationResponse.title}" for [${senderId}].`);
                                }
                            }
                        } else {
                             // The JSON was valid but wasn't in the task format. Treat as regular text.
                            console.log(`index.ts: Gemini response was valid JSON but not a task for [${senderId}]. Treating as text.`);
                            twiml.message(geminiResponseText);
                        }
                    } catch (error) {
                        // JSON.parse failed, which means it's a regular string chat response.
                        console.log(`index.ts: Gemini response for [${senderId}] was not JSON. Treating as a standard chat message.`);
                        if (!geminiResponseText) {
                            twiml.message("I'm having a little trouble thinking right now. Please try again in a moment!");
                            console.warn(`index.ts: Gemini chat returned an empty response for [${senderId}]. Using fallback message.`);
                        } else {
                            twiml.message(geminiResponseText);
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
app.listen(PORT, () => {
    console.log(`index.ts: Express server started and listening on port ${PORT}.`);
    console.log(`index.ts: Twilio webhook endpoint available at /webhook/twilio`);
    console.log(`index.ts: Google OAuth initiation route available at ${SERVER_BASE_URL}/auth/google/initiate?senderId=YOUR_SENDER_ID`);
    console.log(`index.ts: Google OAuth callback configured for ${GOOGLE_REDIRECT_URI}`);
}); 