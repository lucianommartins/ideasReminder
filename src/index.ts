// --- IMPORTS ---
// For loading environment variables from a .env file
import * as dotenv from 'dotenv';
import express, { Request, Response } from 'express'; // Explicitly import Request, Response
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
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PORT = process.env.PORT || '3000'; // Default to port 3000 if not specified

if (!TWILIO_ACCOUNT_SID) {
    console.error('index.ts: FATAL ERROR - TWILIO_ACCOUNT_SID is not set. Application will exit.');
    process.exit(1);
}
if (!TWILIO_AUTH_TOKEN) {
    console.error('index.ts: FATAL ERROR - TWILIO_AUTH_TOKEN is not set. Application will exit.');
    process.exit(1);
}
if (!GEMINI_API_KEY) {
    console.error('index.ts: FATAL ERROR - GEMINI_API_KEY is not set. Application will exit.');
    process.exit(1);
}
console.log('index.ts: Environment variables validated successfully.');

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
                        console.log(`index.ts: Processing downloaded audio [${localMediaFilePath}] with Gemini for [${senderId}]. Prompt: "${effectivePrompt}"`);
                        geminiMediaResponse = await processAudioWithGemini(ai, senderId, localMediaFilePath, mediaContentType, effectivePrompt, chatHistories);
                    } else if (supportedImageTypes.includes(mediaContentType)) {
                        effectivePrompt = (userMessage && userMessage.trim() !== "") ? userMessage : FIXED_TEXT_PROMPT_FOR_IMAGE;
                        console.log(`index.ts: Processing downloaded image [${localMediaFilePath}] with Gemini for [${senderId}]. Prompt: "${effectivePrompt}"`);
                        geminiMediaResponse = await processImageWithGemini(ai, senderId, localMediaFilePath, mediaContentType, effectivePrompt, chatHistories);
                    } else if (supportedVideoTypes.includes(mediaContentType)) {
                        effectivePrompt = (userMessage && userMessage.trim() !== "") ? userMessage : FIXED_TEXT_PROMPT_FOR_VIDEO;
                        console.log(`index.ts: Processing downloaded video [${localMediaFilePath}] with Gemini for [${senderId}]. Prompt: "${effectivePrompt}"`);
                        geminiMediaResponse = await processVideoWithGemini(ai, senderId, localMediaFilePath, mediaContentType, effectivePrompt, chatHistories);
                    } else if (supportedDocumentTypes.includes(mediaContentType)) {
                        effectivePrompt = (userMessage && userMessage.trim() !== "") ? userMessage : FIXED_TEXT_PROMPT_FOR_DOCUMENT;
                        console.log(`index.ts: Processing downloaded document [${localMediaFilePath}] with Gemini for [${senderId}]. Prompt: "${effectivePrompt}"`);
                        geminiMediaResponse = await processDocumentWithGemini(ai, senderId, localMediaFilePath, mediaContentType, effectivePrompt, chatHistories);
                    } else {
                        console.warn(`index.ts: User [${senderId}] sent an unsupported media file type: ${mediaContentType}.`);
                        twiml.message("The media file type you sent is not currently supported. Please try an image, audio, video, or a common document format (PDF, DOCX, PPTX, XLSX).");
                        // No further processing for unsupported types, twiml message is set.
                    }

                    if (geminiMediaResponse === undefined && !twiml.response.children.length) {
                        // This case handles if a supported type was routed but the processing function (once implemented) failed to return a response.
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
            let geminiResponseText = await generateGeminiChatResponse(ai, senderId, incomingMsg, chatHistories);
            console.log(`index.ts: Gemini chat response for [${senderId}]: "${geminiResponseText}"`);
            if (!geminiResponseText) {
                geminiResponseText = "I'm having a little trouble thinking right now. Please try again in a moment!";
                console.warn(`index.ts: Gemini chat returned an empty response for [${senderId}]. Using fallback message.`);
            }
            twiml.message(geminiResponseText);
        }
    }

    console.log(`index.ts: Sending final TwiML response to [${senderId}].`);
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(twiml.toString());
});

// --- START EXPRESS SERVER ---
app.listen(PORT, () => {
    console.log(`index.ts: Express server started and listening on port ${PORT}. Webhook is available at /webhook/twilio`);
}); 