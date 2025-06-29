/**
 * @file gemini.ts
 * @description This module encapsulates all interactions with the Google Gemini API.
 * It provides functions to handle text-only chats and multimodal chats (text with media),
 * manage conversation history, and conditionally apply system instructions.
 */

import { GoogleGenAI, createPartFromUri, Part } from "@google/genai";
import { ChatHistoryItem, ChatHistories, ChatMessagePart } from "../types/chat";
import { systemInstruction } from "./prompts";

/**
 * Defines the standardized response structure from Gemini interactions.
 */
interface GeminiChatInteractionResult {
    modelResponseText: string;
    googleSearchUsed: boolean;
}

/**
 * A private helper function to perform the core chat interaction with the Gemini API.
 * @param aiClient The initialized GoogleGenAI client.
 * @param senderId A unique identifier for the user, used for logging.
 * @param currentHistoryForUser The user's current chat history.
 * @param messageContentToSend The content to send (string for text, Part[] for multimodal).
 * @param userHistoryPartsToLog The representation of the user's message to be saved in history.
 * @param useSystemInstruction A flag to control whether to use the main system instruction.
 * @returns A promise resolving to a GeminiChatInteractionResult.
 */
async function _performGeminiChatInteraction(
    aiClient: GoogleGenAI,
    senderId: string, 
    currentHistoryForUser: ChatHistoryItem[],
    messageContentToSend: string | Part[],
    userHistoryPartsToLog: ChatMessagePart[],
    useSystemInstruction: boolean = true
): Promise<GeminiChatInteractionResult> {
    console.log(`gemini.ts_internal: Starting a new chat session for [${senderId}] with model gemini-2.5-flash.`);
    
    const config: any = {
        tools: [{ googleSearch: {} }],
    };

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

    // Check if grounding with Google Search was used.
    const groundingSupports = response.candidates?.[0]?.groundingMetadata?.groundingSupports;
    if (groundingSupports && groundingSupports.length > 0) {
        googleSearchUsed = true;
        console.log(`gemini.ts_internal: Google Search tool was used by the model for [${senderId}].`);
    }

    if (modelResponseText) {
        console.log(`gemini.ts_internal: Successfully generated text from Gemini for [${senderId}].`);
    } else {
        console.warn(`gemini.ts_internal: Gemini API returned empty text for [${senderId}].`);
    }

    return { modelResponseText, googleSearchUsed };
}

/**
 * Generates a text-based chat response from Gemini and updates the conversation history.
 * @param aiClient The initialized GoogleGenAI client.
 * @param senderId The unique identifier for the user.
 * @param newUserMessage The new text message from the user.
 * @param chatHistories A record of all user chat histories.
 * @param useSystemInstruction A flag to control whether to use system instructions.
 * @returns A promise that resolves to the standardized response object.
 */
export async function generateGeminiChatResponse(
    aiClient: GoogleGenAI,
    senderId: string,
    newUserMessage: string,
    chatHistories: ChatHistories,
    useSystemInstruction: boolean
): Promise<{responseText: string, googleSearchUsed: boolean}> {
    console.log(`gemini.ts: New text message from user [${senderId}]: "${newUserMessage}"`);
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

        if (modelResponseText) {
            currentHistory.push({ role: "user", parts: userHistoryParts });
            currentHistory.push({ role: "model", parts: [{ text: modelResponseText }] });
            chatHistories[senderId] = currentHistory;
        }

        return { responseText: modelResponseText, googleSearchUsed };

    } catch (error) {
        console.error(`gemini.ts: Error in generateGeminiChatResponse for [${senderId}]:`, error);
        return { responseText: "Sorry, I encountered an error while processing your message. Please try again.", googleSearchUsed: false };
    }
}

/**
 * A generic, private function to process any media file with Gemini.
 * It uploads the file, sends it to the model with a prompt, and updates chat history.
 * @param mediaType A string descriptor for the media type (e.g., "Audio", "Image") for logging.
 * @param aiClient The initialized GoogleGenAI client.
 * @param senderId The user's unique identifier.
 * @param filePath The local path to the media file.
 * @param mimeType The MIME type of the media file.
 * @param textPrompt The text prompt to accompany the media.
 * @param chatHistories The collection of all user chat histories.
 * @param useSystemInstruction A flag to control whether to use system instructions.
 * @returns A promise that resolves to the standardized response object.
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
        const uploadedFile = await aiClient.files.upload({
            file: filePath,
            config: { mimeType: mimeType },
        });

        if (!uploadedFile.uri || !uploadedFile.mimeType) {
            console.error(`gemini.ts: Invalid file upload response for ${mediaType} from [${senderId}].`);
            const errorText = `Sorry, there was a problem uploading your ${mediaType.toLowerCase()} file.`;
            return { responseText: errorText, googleSearchUsed: false };
        }

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
        
        if (modelResponseText) {
            currentHistory.push({ role: "user", parts: userHistoryPartsToLog });
            currentHistory.push({ role: "model", parts: [{ text: modelResponseText }] });
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
 * All parameters are passed to the internal _processMediaWithGemini function.
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
 * All parameters are passed to the internal _processMediaWithGemini function.
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
 * All parameters are passed to the internal _processMediaWithGemini function.
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
 * All parameters are passed to the internal _processMediaWithGemini function.
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
