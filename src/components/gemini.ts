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
 * System-level instructions to prime the Gemini model for consistent behavior.
 * This instruction ensures the model always replies in the same language as the user.
 */
const LANGUAGE_PRIMING_USER = "IMPORTANT: From now on, you MUST respond in the exact same language I use. If I use Portuguese, you respond in Portuguese. If I use English, you respond in English. Do not translate unless I explicitly ask you to.";
const LANGUAGE_PRIMING_MODEL = "Understood. I will always respond in the same language as your message.";

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
    // Create a temporary history for this specific API call to avoid mutating the stored history.
    const historyForThisTurn = [...currentHistoryForUser];

    // Prepend the language priming instruction to the start of the conversation history.
    // This ensures Gemini always gets the instruction to reply in the user's language.
    // We prepend it every time to a temporary copy, so the actual stored history remains clean.
    historyForThisTurn.unshift(
        { role: "model", parts: [{ text: LANGUAGE_PRIMING_MODEL }] },
        { role: "user", parts: [{ text: LANGUAGE_PRIMING_USER }] }
    );
    
    console.log(`gemini.ts_internal: Creating/continuing chat session for [${senderId}] with model gemini-2.5-flash.`);
    const chat = aiClient.chats.create({
        model: "gemini-2.5-flash",
        history: historyForThisTurn,
        config: {
            thinkingConfig: {
                thinkingBudget: 0,
            },
            tools: [{ googleSearch: {} }],
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

    const currentHistory: ChatHistoryItem[] = chatHistories[senderId] || [];
    console.log(`gemini.ts: Current history for [${senderId}]:`, JSON.stringify(currentHistory, null, 2));

    try {
        const userHistoryParts: ChatMessagePart[] = [{ text: newUserMessage }];
        
        const { modelResponseText, userHistoryEntry, modelHistoryEntry } = await _performGeminiChatInteraction(
            aiClient,
            senderId,
            currentHistory,
            newUserMessage,
            userHistoryParts
        );

        if (modelResponseText && userHistoryEntry && modelHistoryEntry) {
            currentHistory.push(userHistoryEntry, modelHistoryEntry);
            chatHistories[senderId] = currentHistory;
        }
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

        const { modelResponseText, userHistoryEntry, modelHistoryEntry } = await _performGeminiChatInteraction(
            aiClient,
            senderId,
            currentHistory,
            messageContentToSend,
            userHistoryPartsToLog
        );

        if (modelResponseText && userHistoryEntry && modelHistoryEntry) {
            currentHistory.push(userHistoryEntry, modelHistoryEntry);
            chatHistories[senderId] = currentHistory;
        }
        
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