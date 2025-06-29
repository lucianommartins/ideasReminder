/**
 * @file gemini.ts
 * @description This module encapsulates all interactions with the Google Gemini API.
 * It handles text chats, processes various media types (audio, image, video, document),
 * maintains conversation history, and includes a priming mechanism to ensure the AI
 * responds in the user's language.
 */

import { GoogleGenAI, createPartFromUri, Part } from "@google/genai";
import { ChatHistoryItem, ChatHistories, ChatMessagePart } from "../types/chat";
import { systemInstruction } from "./prompts";

/**
 * Interface for the result of the internal chat interaction helper.
 */
interface GeminiChatInteractionResult {
    modelResponseText: string;
    googleSearchUsed: boolean;
}

/**
 * Internal helper function to perform a chat interaction with Gemini.
 * @param aiClient The initialized GoogleGenAI client instance.
 * @param senderId The unique identifier for the user/sender (for logging).
 * @param currentHistoryForUser The current chat history for this specific user.
 * @param messageContentToSend The content to send to Gemini (string for text, Part[] for multimodal).
 * @param userHistoryPartsToLog The parts of the user's message to log in history.
 * @param useSystemInstruction A flag to control whether to use system instructions.
 * @returns A promise that resolves to a GeminiChatInteractionResult.
 */
async function _performGeminiChatInteraction(
    aiClient: GoogleGenAI,
    senderId: string, // For logging
    currentHistoryForUser: ChatHistoryItem[],
    messageContentToSend: string | Part[],
    userHistoryPartsToLog: ChatMessagePart[],
    useSystemInstruction: boolean = true // Added flag to control instruction usage
): Promise<GeminiChatInteractionResult> {
    console.log(`gemini.ts_internal: Starting a new chat session for [${senderId}] with model gemini-2.5-flash.`);
    
    // Base configuration
    const config: any = {
        tools: [
            {
                googleSearch: {},
            }
        ],
    };

    // Conditionally add system instruction
    if (useSystemInstruction) {
        config.systemInstruction = systemInstruction;
    }

    const chat = aiClient.chats.create({
        model: "gemini-2.5-flash",
        history: currentHistoryForUser,
        config: config,
    });

    console.log(`gemini.ts_internal: Sending message to Gemini for [${senderId}]. Content type: ${typeof messageContentToSend === 'string' ? 'text' : 'multimodal'}`);
    const response = await chat.sendMessage({ message: messageContentToSend });

    const modelResponseText = response.text ? response.text.trim() : '';
    let googleSearchUsed = false;

    // Correct way to check for grounding with Google Search.
    // We store the potentially undefined property in a variable first
    // to make the check more explicit and satisfy the linter.
    const groundingSupports = response.candidates?.[0]?.groundingMetadata?.groundingSupports;
    if (groundingSupports && groundingSupports.length > 0) {
        googleSearchUsed = true;
        console.log(`gemini.ts_internal: Google Search tool was used by the model for [${senderId}].`);
    }

    if (modelResponseText) {
        console.log(`gemini.ts_internal: Successfully generated text from Gemini for [${senderId}]: "${modelResponseText}"`);
    } else {
        console.warn(`gemini.ts_internal: Gemini API returned empty text for [${senderId}].`);
    }

    return { modelResponseText, googleSearchUsed };
}

/**
 * Generates a chat response using the Gemini API, maintaining conversation history.
 * @param aiClient The initialized GoogleGenAI client instance.
 * @param senderId The unique identifier for the user/sender.
 * @param newUserMessage The new message from the user.
 * @param chatHistories An object storing chat histories for all users.
 * @param useSystemInstruction A flag to control whether to use system instructions.
 * @returns A promise that resolves to the generated text response, or an empty string if an error occurs.
 */
export async function generateGeminiChatResponse(
    aiClient: GoogleGenAI,
    senderId: string,
    newUserMessage: string,
    chatHistories: ChatHistories,
    useSystemInstruction: boolean
): Promise<{responseText: string, googleSearchUsed: boolean}> {
    console.log(`gemini.ts: Entered generateGeminiChatResponse() for sender [${senderId}].`);
    console.log(`gemini.ts: New message from user [${senderId}]: "${newUserMessage}"`);

    const currentHistory: ChatHistoryItem[] = chatHistories[senderId] || [];

    try {
        const userHistoryParts: ChatMessagePart[] = [{ text: newUserMessage }];
        
        const { modelResponseText, googleSearchUsed } = await _performGeminiChatInteraction(
            aiClient,
            senderId,
            currentHistory,
            newUserMessage,
            userHistoryParts,
            useSystemInstruction
        );

        // Restore history saving
        if (modelResponseText) {
            currentHistory.push({
                role: "user",
                parts: userHistoryParts,
            });
            currentHistory.push({
                role: "model",
                parts: [{ text: modelResponseText }],
            });
            chatHistories[senderId] = currentHistory;
        }

        return { responseText: modelResponseText, googleSearchUsed };

    } catch (error) {
        console.error(`gemini.ts: Error in generateGeminiChatResponse for [${senderId}]:`, error);
        return { responseText: "Sorry, I encountered an error while processing your message. Please try again.", googleSearchUsed: false };
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
 * @param useSystemInstruction A flag to control whether to use system instructions.
 * @returns A promise that resolves to the generated text response.
 */
async function _processMediaWithGemini(
    mediaType: 'Audio' | 'Image' | 'Video' | 'Document',
    aiClient: GoogleGenAI,
    senderId: string,
    filePath: string,
    mimeType: string,
    textPrompt: string,
    chatHistories: ChatHistories,
    useSystemInstruction: boolean
): Promise<{responseText: string, googleSearchUsed: boolean}> {
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
            const errorText = `Sorry, there was a problem uploading your ${mediaType.toLowerCase()} file.`;
            return { responseText: errorText, googleSearchUsed: false };
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

        const { modelResponseText, googleSearchUsed } = await _performGeminiChatInteraction(
            aiClient,
            senderId,
            currentHistory,
            messageContentToSend,
            userHistoryPartsToLog,
            useSystemInstruction
        );
        
        // Restore history saving for media processing
        if (modelResponseText) {
            currentHistory.push({
                role: "user",
                parts: userHistoryPartsToLog,
            });
            currentHistory.push({
                role: "model",
                parts: [{ text: modelResponseText }],
            });
            chatHistories[senderId] = currentHistory;
        }
        
        return { responseText: modelResponseText, googleSearchUsed };

    } catch (error) {
        console.error(`gemini.ts: Error processing ${mediaType} for [${senderId}]:`, error);
        const errorText = `Sorry, I encountered an error trying to understand your ${mediaType.toLowerCase()}. Please try again later.`;
        return { responseText: errorText, googleSearchUsed: false };
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
    chatHistories: ChatHistories,
    useSystemInstruction: boolean
): Promise<{responseText: string, googleSearchUsed: boolean}> {
    return _processMediaWithGemini('Audio', aiClient, senderId, audioFilePath, audioMimeType, textPrompt, chatHistories, useSystemInstruction);
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
    chatHistories: ChatHistories,
    useSystemInstruction: boolean
): Promise<{responseText: string, googleSearchUsed: boolean}> {
    return _processMediaWithGemini('Image', aiClient, senderId, imageFilePath, imageMimeType, textPrompt, chatHistories, useSystemInstruction);
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
    chatHistories: ChatHistories,
    useSystemInstruction: boolean
): Promise<{responseText: string, googleSearchUsed: boolean}> {
    return _processMediaWithGemini('Video', aiClient, senderId, videoFilePath, videoMimeType, textPrompt, chatHistories, useSystemInstruction);
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
    chatHistories: ChatHistories,
    useSystemInstruction: boolean
): Promise<{responseText: string, googleSearchUsed: boolean}> {
    return _processMediaWithGemini('Document', aiClient, senderId, documentFilePath, documentMimeType, textPrompt, chatHistories, useSystemInstruction);
}
