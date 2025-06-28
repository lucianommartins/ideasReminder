"use strict";
/**
 * @file gemini.ts
 * @description This module encapsulates all interactions with the Google Gemini API.
 * It handles text chats, processes various media types (audio, image, video, document),
 * maintains conversation history, and includes a priming mechanism to ensure the AI
 * responds in the user's language.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateGeminiChatResponse = generateGeminiChatResponse;
exports.processAudioWithGemini = processAudioWithGemini;
exports.processImageWithGemini = processImageWithGemini;
exports.processVideoWithGemini = processVideoWithGemini;
exports.processDocumentWithGemini = processDocumentWithGemini;
const genai_1 = require("@google/genai");
const prompts_1 = require("./prompts");
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
async function _performGeminiChatInteraction(aiClient, senderId, // For logging
currentHistoryForUser, messageContentToSend, userHistoryPartsToLog, useSystemInstruction = true // Added flag to control instruction usage
) {
    console.log(`gemini.ts_internal: Starting a new chat session for [${senderId}] with model gemini-2.5-flash.`);
    // Base configuration
    const config = {
        tools: [
            {
                googleSearch: {},
            }
        ],
    };
    // Conditionally add system instruction
    if (useSystemInstruction) {
        config.systemInstruction = prompts_1.systemInstruction;
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
    }
    else {
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
async function generateGeminiChatResponse(aiClient, senderId, newUserMessage, chatHistories, useSystemInstruction) {
    console.log(`gemini.ts: Entered generateGeminiChatResponse() for sender [${senderId}].`);
    console.log(`gemini.ts: New message from user [${senderId}]: "${newUserMessage}"`);
    const currentHistory = chatHistories[senderId] || [];
    try {
        const userHistoryParts = [{ text: newUserMessage }];
        const { modelResponseText, googleSearchUsed } = await _performGeminiChatInteraction(aiClient, senderId, currentHistory, newUserMessage, userHistoryParts, useSystemInstruction);
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
    }
    catch (error) {
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
async function _processMediaWithGemini(mediaType, aiClient, senderId, filePath, mimeType, textPrompt, chatHistories, useSystemInstruction) {
    console.log(`gemini.ts: Processing ${mediaType} for [${senderId}]. File: ${filePath}, Type: ${mimeType}`);
    const currentHistory = chatHistories[senderId] || [];
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
        const messageContentToSend = [
            (0, genai_1.createPartFromUri)(uploadedFile.uri, uploadedFile.mimeType),
            { text: textPrompt },
        ];
        const userHistoryPartsToLog = [
            { fileData: { mimeType: mimeType, fileUri: uploadedFile.uri } },
            { text: textPrompt }
        ];
        const { modelResponseText, googleSearchUsed } = await _performGeminiChatInteraction(aiClient, senderId, currentHistory, messageContentToSend, userHistoryPartsToLog, useSystemInstruction);
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
        // For media processing, we'll return only the text for now to keep the interface simple.
        // The search usage information is lost here, but can be added if needed by changing the return type.
        return modelResponseText;
    }
    catch (error) {
        console.error(`gemini.ts: Error processing ${mediaType} for [${senderId}]:`, error);
        return `Sorry, I encountered an error trying to understand your ${mediaType.toLowerCase()}. Please try again later.`;
    }
}
/**
 * Processes an audio file with Gemini by calling the generic media processor.
 */
async function processAudioWithGemini(aiClient, senderId, audioFilePath, audioMimeType, textPrompt, chatHistories, useSystemInstruction) {
    return _processMediaWithGemini('Audio', aiClient, senderId, audioFilePath, audioMimeType, textPrompt, chatHistories, useSystemInstruction);
}
/**
 * Processes an image file with Gemini by calling the generic media processor.
 */
async function processImageWithGemini(aiClient, senderId, imageFilePath, imageMimeType, textPrompt, chatHistories, useSystemInstruction) {
    return _processMediaWithGemini('Image', aiClient, senderId, imageFilePath, imageMimeType, textPrompt, chatHistories, useSystemInstruction);
}
/**
 * Processes a video file with Gemini by calling the generic media processor.
 */
async function processVideoWithGemini(aiClient, senderId, videoFilePath, videoMimeType, textPrompt, chatHistories, useSystemInstruction) {
    return _processMediaWithGemini('Video', aiClient, senderId, videoFilePath, videoMimeType, textPrompt, chatHistories, useSystemInstruction);
}
/**
 * Processes a document file with Gemini by calling the generic media processor.
 */
async function processDocumentWithGemini(aiClient, senderId, documentFilePath, documentMimeType, textPrompt, chatHistories, useSystemInstruction) {
    return _processMediaWithGemini('Document', aiClient, senderId, documentFilePath, documentMimeType, textPrompt, chatHistories, useSystemInstruction);
}
