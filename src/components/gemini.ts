/**
 * @file gemini.ts
 * @description This module encapsulates all interactions with the Google Gemini API.
 * It handles text chats, processes various media types (audio, image, video, document),
 * maintains conversation history, and includes a priming mechanism to ensure the AI
 * responds in the user's language.
 */

import { GoogleGenAI, createPartFromUri, Part } from "@google/genai";
import { ChatHistoryItem, ChatHistories, ChatMessagePart } from "../types/chat";

/**
 * System-level instructions to prime the Gemini model for its role as a task identifier.
 */
const systemInstruction = `
Your primary role is to be a world-class assistant for identifying and structuring tasks from user messages.

You have two modes of operation:
1. "Task Identification Mode": If the user's message implies they want to create a task, a to-do, a reminder, or any actionable item.
2. "Normal Chat Mode": For any other type of conversation.

**Rules for Task Identification Mode:**
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

**Rules for Normal Chat Mode:**
- If the message is NOT a task request (e.g., it's a greeting, a question, a random statement), you must respond as a friendly, helpful assistant.
- Your response in this mode MUST be a simple string.
- Do NOT use JSON in this mode.

**Language Priming:**
- IMPORTANT: You MUST respond in the exact same language the user uses. If they use Portuguese, you respond in Portuguese (for both chat and the content of the JSON fields). If they use English, you respond in English.

Example 1 (Task in English):
User: "hey can you remind me to build that new feature for the homepage? it needs to be a carousel that shows trending products"
Your response:
{
  "isTask": true,
  "details": {
    "objective": "Develop new homepage carousel feature",
    "description": "Build and implement a product carousel on the homepage to display trending products.",
    "final_result": "A functional carousel on the live homepage, dynamically showing the latest trending products.",
    "user_experience": "Customers will easily discover and engage with trending products, increasing sales."
  }
}

Example 2 (Chat in Portuguese):
User: "oi, tudo bem?"
Your response:
"Olá! Tudo bem por aqui. Como posso te ajudar hoje?"
`.trim();

export const FIXED_TEXT_PROMPT_FOR_AUDIO = "Transcribe this audio. If it's music, identify the song and artist.";
export const FIXED_TEXT_PROMPT_FOR_IMAGE = "Describe this image in detail.";
export const FIXED_TEXT_PROMPT_FOR_VIDEO = "Describe what happens in this video.";
export const FIXED_TEXT_PROMPT_FOR_DOCUMENT = "Summarize this document.";

/**
 * Interface for the result of the internal chat interaction helper.
 */
interface GeminiChatInteractionResult {
    modelResponseText: string;
    userHistoryEntry: ChatHistoryItem | null;
    modelHistoryEntry: ChatHistoryItem | null;
}

/**
 * Internal helper function to perform a chat interaction with Gemini.
 * @param aiClient The initialized GoogleGenAI client instance.
 * @param senderId The unique identifier for the user/sender (for logging).
 * @param currentHistoryForUser The current chat history for this specific user.
 * @param messageContentToSend The content to send to Gemini (string for text, Part[] for multimodal).
 * @param userHistoryPartsToLog The parts of the user's message to log in history.
 * @returns A promise that resolves to a GeminiChatInteractionResult.
 */
async function _performGeminiChatInteraction(
    aiClient: GoogleGenAI,
    senderId: string, // For logging
    currentHistoryForUser: ChatHistoryItem[],
    messageContentToSend: string | Part[],
    userHistoryPartsToLog: ChatMessagePart[]
): Promise<GeminiChatInteractionResult> {
    // We no longer use the stored history directly for the turn, as the system prompt guides the model.
    // History can still be valuable for context but is managed differently.
    // For this implementation, we simplify and focus on the single-turn instruction.
    
    console.log(`gemini.ts_internal: Starting a new chat session for [${senderId}] with model gemini-2.5-flash.`);
    const chat = aiClient.chats.create({
        model: "gemini-2.5-flash",
        config: {
            // Ensure the model outputs JSON when requested by setting the response MIME type.
            // This is a powerful hint to the model to follow the JSON instruction.
            responseMimeType: "application/json",
            // The system instruction is now the primary guide for the model's behavior.
            systemInstruction: systemInstruction,
        },
    });

    console.log(`gemini.ts_internal: Sending message to Gemini for [${senderId}]. Content type: ${typeof messageContentToSend === 'string' ? 'text' : 'multimodal'}`);
    const response = await chat.sendMessage({ message: messageContentToSend });

    const modelResponseText = response.text ? response.text.trim() : '';
    let userHistoryEntry: ChatHistoryItem | null = null;
    let modelHistoryEntry: ChatHistoryItem | null = null;

    if (modelResponseText) {
        console.log(`gemini.ts_internal: Successfully generated text from Gemini for [${senderId}]: "${modelResponseText}"`);
        userHistoryEntry = { role: "user", parts: userHistoryPartsToLog };
        modelHistoryEntry = { role: "model", parts: [{ text: modelResponseText }] };
    } else {
        console.warn(`gemini.ts_internal: Gemini API returned empty text for [${senderId}].`);
    }

    return { modelResponseText, userHistoryEntry, modelHistoryEntry };
}

/**
 * Generates a chat response using the Gemini API, maintaining conversation history.
 * @param aiClient The initialized GoogleGenAI client instance.
 * @param senderId The unique identifier for the user/sender.
 * @param newUserMessage The new message from the user.
 * @param chatHistories An object storing chat histories for all users.
 * @returns A promise that resolves to the generated text response, or an empty string if an error occurs.
 */
export async function generateGeminiChatResponse(
    aiClient: GoogleGenAI,
    senderId: string,
    newUserMessage: string,
    chatHistories: ChatHistories
): Promise<string> {
    console.log(`gemini.ts: Entered generateGeminiChatResponse() for sender [${senderId}].`);
    console.log(`gemini.ts: New message from user [${senderId}]: "${newUserMessage}"`);

    // The chat history is not passed to the model for this specific use case,
    // as each message is evaluated independently for task creation intent.
    const currentHistory: ChatHistoryItem[] = [];

    try {
        const userHistoryParts: ChatMessagePart[] = [{ text: newUserMessage }];
        
        const { modelResponseText, userHistoryEntry, modelHistoryEntry } = await _performGeminiChatInteraction(
            aiClient,
            senderId,
            currentHistory,
            newUserMessage,
            userHistoryParts
        );

        // We don't save history for this model, as each turn is stateless.
        // if (modelResponseText && userHistoryEntry && modelHistoryEntry) {
        //     currentHistory.push(userHistoryEntry, modelHistoryEntry);
        //     chatHistories[senderId] = currentHistory;
        // }
        return modelResponseText;

    } catch (error) {
        console.error(`gemini.ts: Error in generateGeminiChatResponse for [${senderId}]:`, error);
        return "Sorry, I encountered an error while processing your message. Please try again.";
    }
}

/**
 * A generic, internal function to process any media file with Gemini.
 * It uploads the file, sends it to the model with a prompt, and updates chat history.
 * @param mediaType A string descriptor for the media type (e.g., "audio", "image") for logging purposes.
 * @param aiClient The initialized GoogleGenAI client.
 * @param senderId The user's unique identifier.
 * @param filePath Path to the local media file.
 * @param mimeType MIME type of the media file.
 * @param textPrompt The text prompt to accompany the media.
 * @param chatHistories The collection of all user chat histories.
 * @returns A promise that resolves to the generated text response.
 */
async function _processMediaWithGemini(
    mediaType: 'Audio' | 'Image' | 'Video' | 'Document',
    aiClient: GoogleGenAI,
    senderId: string,
    filePath: string,
    mimeType: string,
    textPrompt: string,
    chatHistories: ChatHistories
): Promise<string> {
    console.log(`gemini.ts: Processing ${mediaType} for [${senderId}]. File: ${filePath}, Type: ${mimeType}`);
    const currentHistory: ChatHistoryItem[] = chatHistories[senderId] || [];

    try {
        console.log(`gemini.ts: Uploading ${mediaType} file [${filePath}] for [${senderId}]...`);
        const uploadedFile = await aiClient.files.upload({
            file: filePath,
            config: { mimeType: mimeType },
        });

        if (!uploadedFile.uri || !uploadedFile.mimeType) {
            console.error(`gemini.ts: Invalid file upload response for ${mediaType} from [${senderId}].`);
            return `Sorry, there was a problem uploading your ${mediaType.toLowerCase()} file.`;
        }
        console.log(`gemini.ts: ${mediaType} file uploaded for [${senderId}]. URI: ${uploadedFile.uri}`);

        const messageContentToSend: Part[] = [
            createPartFromUri(uploadedFile.uri, uploadedFile.mimeType),
            { text: textPrompt },
        ];
        
        const userHistoryPartsToLog: ChatMessagePart[] = [
            { fileData: { mimeType: mimeType, fileUri: uploadedFile.uri } },
            { text: textPrompt }
        ];

        // The chat history is not passed to the model for this specific use case.
        const { modelResponseText, userHistoryEntry, modelHistoryEntry } = await _performGeminiChatInteraction(
            aiClient,
            senderId,
            [], // Sending empty history
            messageContentToSend,
            userHistoryPartsToLog
        );

        // We don't save history for this model.
        // if (modelResponseText && userHistoryEntry && modelHistoryEntry) {
        //     currentHistory.push(userHistoryEntry, modelHistoryEntry);
        //     chatHistories[senderId] = currentHistory;
        // }
        
        return modelResponseText;

    } catch (error) {
        console.error(`gemini.ts: Error processing ${mediaType} for [${senderId}]:`, error);
        return `Sorry, I encountered an error trying to understand your ${mediaType.toLowerCase()}. Please try again later.`;
    }
}

/**
 * Processes an audio file with Gemini by calling the generic media processor.
 */
export async function processAudioWithGemini(
    aiClient: GoogleGenAI,
    senderId: string,
    audioFilePath: string,
    audioMimeType: string,
    textPrompt: string,
    chatHistories: ChatHistories
): Promise<string> {
    return _processMediaWithGemini('Audio', aiClient, senderId, audioFilePath, audioMimeType, textPrompt, chatHistories);
}

/**
 * Processes an image file with Gemini by calling the generic media processor.
 */
export async function processImageWithGemini(
    aiClient: GoogleGenAI,
    senderId: string,
    imageFilePath: string,
    imageMimeType: string,
    textPrompt: string,
    chatHistories: ChatHistories
): Promise<string> {
    return _processMediaWithGemini('Image', aiClient, senderId, imageFilePath, imageMimeType, textPrompt, chatHistories);
}

/**
 * Processes a video file with Gemini by calling the generic media processor.
 */
export async function processVideoWithGemini(
    aiClient: GoogleGenAI,
    senderId: string,
    videoFilePath: string,
    videoMimeType: string,
    textPrompt: string,
    chatHistories: ChatHistories
): Promise<string> {
    return _processMediaWithGemini('Video', aiClient, senderId, videoFilePath, videoMimeType, textPrompt, chatHistories);
}

/**
 * Processes a document file with Gemini by calling the generic media processor.
 */
export async function processDocumentWithGemini(
    aiClient: GoogleGenAI,
    senderId: string,
    documentFilePath: string,
    documentMimeType: string,
    textPrompt: string,
    chatHistories: ChatHistories
): Promise<string> {
    return _processMediaWithGemini('Document', aiClient, senderId, documentFilePath, documentMimeType, textPrompt, chatHistories);
} 