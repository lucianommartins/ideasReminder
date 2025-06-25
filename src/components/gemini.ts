import { GoogleGenAI, createPartFromUri, Part } from "@google/genai";
import { ChatHistoryItem, ChatHistories, ChatMessagePart } from "../types/chat";

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
    console.log(`gemini.ts_internal: Creating/continuing chat session for [${senderId}] with model gemini-2.5-flash.`);
    const chat = aiClient.chats.create({
        model: "gemini-2.5-flash",
        history: currentHistoryForUser,
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
            newUserMessage, // Send as simple string
            userHistoryParts
        );

        if (modelResponseText && userHistoryEntry && modelHistoryEntry) {
            currentHistory.push(userHistoryEntry);
            currentHistory.push(modelHistoryEntry);
            chatHistories[senderId] = currentHistory;
            console.log(`gemini.ts: Updated history for [${senderId}] after text chat:`, JSON.stringify(chatHistories[senderId], null, 2));
        }
        return modelResponseText;

    } catch (error) {
        console.error(`gemini.ts: An error occurred while calling Gemini chat API for [${senderId}]:`, error);
        if (error instanceof Error) {
            console.error(`  Error Type: ${error.constructor.name}`);
            console.error(`  Error Name: ${error.name}`);
            console.error(`  Error Message: ${error.message}`);
            if (error.stack) {
                console.error(`  Stack Trace:\n${error.stack}`);
            }
        } else {
            console.error('  An unknown or non-standard error object was caught:', error);
        }
        return '';
    } finally {
        console.log(`gemini.ts: generateGeminiChatResponse() function execution finished for [${senderId}].`);
    }
}

/**
 * Processes an audio file with Gemini using a fixed prompt, maintaining conversation history.
 * @param aiClient The initialized GoogleGenAI client instance.
 * @param senderId The unique identifier for the user/sender.
 * @param audioFilePath Path to the local audio file.
 * @param audioMimeType MIME type of the audio file (e.g., "audio/ogg", "audio/mpeg").
 * @param textPrompt The fixed text prompt to send along with the audio.
 * @param chatHistories An object storing chat histories for all users.
 * @returns A promise that resolves to the generated text response, or an empty string if an error occurs.
 */
export async function processAudioWithGemini(
    aiClient: GoogleGenAI,
    senderId: string,
    audioFilePath: string,
    audioMimeType: string,
    textPrompt: string,
    chatHistories: ChatHistories
): Promise<string> {
    console.log(`gemini.ts: Entered processAudioWithGemini() for sender [${senderId}]. Audio: ${audioFilePath}, Type: ${audioMimeType}, Prompt: "${textPrompt}"`);

    const currentHistory: ChatHistoryItem[] = chatHistories[senderId] || [];
    console.log(`gemini.ts: Current history for [${senderId}] before audio processing:`, JSON.stringify(currentHistory, null, 2));

    try {
        console.log(`gemini.ts: Uploading audio file [${audioFilePath}] to Gemini for [${senderId}]...`);
        const uploadedFile = await aiClient.files.upload({
            file: audioFilePath,
            config: { mimeType: audioMimeType },
        });
        console.log(`gemini.ts: Audio file uploaded for [${senderId}]. URI: ${uploadedFile.uri}, MIME Type: ${uploadedFile.mimeType}, Name: ${uploadedFile.name}`);

        if (!uploadedFile.uri || typeof uploadedFile.uri !== 'string') {
            console.error(`gemini.ts: Uploaded file response from Gemini is missing a valid URI for [${senderId}].`);
            return '';
        }
        if (!uploadedFile.mimeType || typeof uploadedFile.mimeType !== 'string') {
            console.error(`gemini.ts: Uploaded file response from Gemini is missing a valid MIME type for [${senderId}].`);
            return '';
        }

        const messageContentToSend: Part[] = [ // This will be sent to Gemini
            createPartFromUri(uploadedFile.uri, uploadedFile.mimeType),
            { text: textPrompt },
        ];
        
        // This is how the user's turn will be logged in history
        const userHistoryPartsToLog: ChatMessagePart[] = [
            { fileData: { mimeType: audioMimeType, fileUri: uploadedFile.uri } },
            { text: textPrompt }
        ];

        const { modelResponseText, userHistoryEntry, modelHistoryEntry } = await _performGeminiChatInteraction(
            aiClient,
            senderId,
            currentHistory,
            messageContentToSend, // Send as Part[]
            userHistoryPartsToLog
        );

        if (modelResponseText && userHistoryEntry && modelHistoryEntry) {
            currentHistory.push(userHistoryEntry);
            currentHistory.push(modelHistoryEntry);
            chatHistories[senderId] = currentHistory;
            console.log(`gemini.ts: Updated history for [${senderId}] after audio processing:`, JSON.stringify(chatHistories[senderId], null, 2));
        }
        
        return modelResponseText;

    } catch (error) {
        console.error(`gemini.ts: An error occurred while processing audio with Gemini for [${senderId}]:`, error);
        if (error instanceof Error) {
            console.error(`  Error Type: ${error.constructor.name}`);
            console.error(`  Error Name: ${error.name}`);
            console.error(`  Error Message: ${error.message}`);
            if (error.stack) {
                console.error(`  Stack Trace:\n${error.stack}`);
            }
        } else {
            console.error('  An unknown or non-standard error object was caught in audio processing for [${senderId}]:', error);
        }
        return '';
    } finally {
        console.log(`gemini.ts: processAudioWithGemini() function execution finished for [${senderId}].`);
    }
}

/**
 * Processes an image file with Gemini using a fixed prompt, maintaining conversation history.
 * @param aiClient The initialized GoogleGenAI client instance.
 * @param senderId The unique identifier for the user/sender.
 * @param imageFilePath Path to the local image file.
 * @param imageMimeType MIME type of the image file (e.g., "image/jpeg", "image/png").
 * @param textPrompt The fixed text prompt to send along with the image.
 * @param chatHistories An object storing chat histories for all users.
 * @returns A promise that resolves to the generated text response, or an empty string if an error occurs.
 */
export async function processImageWithGemini(
    aiClient: GoogleGenAI,
    senderId: string,
    imageFilePath: string,
    imageMimeType: string,
    textPrompt: string,
    chatHistories: ChatHistories
): Promise<string> {
    console.log(`gemini.ts: Entered processImageWithGemini() for sender [${senderId}]. Image: ${imageFilePath}, Type: ${imageMimeType}, Prompt: "${textPrompt}"`);

    const currentHistory: ChatHistoryItem[] = chatHistories[senderId] || [];
    console.log(`gemini.ts: Current history for [${senderId}] before image processing:`, JSON.stringify(currentHistory, null, 2));

    try {
        console.log(`gemini.ts: Uploading image file [${imageFilePath}] to Gemini for [${senderId}]...`);
        const uploadedFile = await aiClient.files.upload({
            file: imageFilePath,
            config: { mimeType: imageMimeType },
        });
        console.log(`gemini.ts: Image file uploaded for [${senderId}]. URI: ${uploadedFile.uri}, MIME Type: ${uploadedFile.mimeType}, Name: ${uploadedFile.name}`);

        if (!uploadedFile.uri || typeof uploadedFile.uri !== 'string') {
            console.error(`gemini.ts: Uploaded file response from Gemini is missing a valid URI for image [${senderId}].`);
            return '';
        }
        if (!uploadedFile.mimeType || typeof uploadedFile.mimeType !== 'string') {
            console.error(`gemini.ts: Uploaded file response from Gemini is missing a valid MIME type for image [${senderId}].`);
            return '';
        }

        const messageContentToSend: Part[] = [
            createPartFromUri(uploadedFile.uri, uploadedFile.mimeType),
            { text: textPrompt },
        ];
        
        const userHistoryPartsToLog: ChatMessagePart[] = [
            { fileData: { mimeType: imageMimeType, fileUri: uploadedFile.uri } },
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
            currentHistory.push(userHistoryEntry);
            currentHistory.push(modelHistoryEntry);
            chatHistories[senderId] = currentHistory;
            console.log(`gemini.ts: Updated history for [${senderId}] after image processing:`, JSON.stringify(chatHistories[senderId], null, 2));
        }
        
        return modelResponseText;

    } catch (error) {
        console.error(`gemini.ts: An error occurred while processing image with Gemini for [${senderId}]:`, error);
        if (error instanceof Error) {
            console.error(`  Error Type: ${error.constructor.name}`);
            console.error(`  Error Name: ${error.name}`);
            console.error(`  Error Message: ${error.message}`);
            if (error.stack) {
                console.error(`  Stack Trace:\n${error.stack}`);
            }
        } else {
            console.error('  An unknown or non-standard error object was caught in image processing for [${senderId}]:', error);
        }
        return '';
    } finally {
        console.log(`gemini.ts: processImageWithGemini() function execution finished for [${senderId}].`);
    }
}

/**
 * Processes a video file with Gemini using a fixed prompt, maintaining conversation history.
 * @param aiClient The initialized GoogleGenAI client instance.
 * @param senderId The unique identifier for the user/sender.
 * @param videoFilePath Path to the local video file.
 * @param videoMimeType MIME type of the video file (e.g., "video/mp4").
 * @param textPrompt The fixed text prompt to send along with the video.
 * @param chatHistories An object storing chat histories for all users.
 * @returns A promise that resolves to the generated text response, or an empty string if an error occurs.
 */
export async function processVideoWithGemini(
    aiClient: GoogleGenAI,
    senderId: string,
    videoFilePath: string,
    videoMimeType: string,
    textPrompt: string,
    chatHistories: ChatHistories
): Promise<string> {
    console.log(`gemini.ts: Entered processVideoWithGemini() for sender [${senderId}]. Video: ${videoFilePath}, Type: ${videoMimeType}, Prompt: "${textPrompt}"`);
    const currentHistory: ChatHistoryItem[] = chatHistories[senderId] || [];
    // Similar implementation to processImageWithGemini, adapted for video
    try {
        const uploadedFile = await aiClient.files.upload({ file: videoFilePath, config: { mimeType: videoMimeType } });
        console.log(`gemini.ts: Video file uploaded for [${senderId}]. URI: ${uploadedFile.uri}, MIME Type: ${uploadedFile.mimeType}, Name: ${uploadedFile.name}`);
        if (!uploadedFile.uri || typeof uploadedFile.uri !== 'string' || !uploadedFile.mimeType || typeof uploadedFile.mimeType !== 'string') {
            console.error(`gemini.ts: Invalid uploaded file response for video [${senderId}].`); return '';
        }
        const messageContentToSend: Part[] = [createPartFromUri(uploadedFile.uri, uploadedFile.mimeType), { text: textPrompt }];
        const userHistoryPartsToLog: ChatMessagePart[] = [{ fileData: { mimeType: videoMimeType, fileUri: uploadedFile.uri } }, { text: textPrompt }];
        const { modelResponseText, userHistoryEntry, modelHistoryEntry } = await _performGeminiChatInteraction(aiClient, senderId, currentHistory, messageContentToSend, userHistoryPartsToLog);
        if (modelResponseText && userHistoryEntry && modelHistoryEntry) {
            currentHistory.push(userHistoryEntry, modelHistoryEntry);
            chatHistories[senderId] = currentHistory;
            console.log(`gemini.ts: Updated history for [${senderId}] after video processing:`, JSON.stringify(chatHistories[senderId], null, 2));
        }
        return modelResponseText;
    } catch (error) {
        console.error(`gemini.ts: An error occurred while processing video with Gemini for [${senderId}]:`, error);
        if (error instanceof Error) {
            console.error(`  Error Type: ${error.constructor.name}`);
            console.error(`  Error Name: ${error.name}`);
            console.error(`  Error Message: ${error.message}`);
            if (error.stack) {
                console.error(`  Stack Trace:\n${error.stack}`);
            }
        } else {
            console.error('  An unknown or non-standard error object was caught in video processing for [${senderId}]:', error);
        }
        return '';
    } finally {
        console.log(`gemini.ts: processVideoWithGemini() function execution finished for [${senderId}].`);
    }
}

/**
 * Processes a document file with Gemini using a fixed prompt, maintaining conversation history.
 * @param aiClient The initialized GoogleGenAI client instance.
 * @param senderId The unique identifier for the user/sender.
 * @param documentFilePath Path to the local document file.
 * @param documentMimeType MIME type of the document file (e.g., "application/pdf").
 * @param textPrompt The fixed text prompt to send along with the document.
 * @param chatHistories An object storing chat histories for all users.
 * @returns A promise that resolves to the generated text response, or an empty string if an error occurs.
 */
export async function processDocumentWithGemini(
    aiClient: GoogleGenAI,
    senderId: string,
    documentFilePath: string,
    documentMimeType: string,
    textPrompt: string,
    chatHistories: ChatHistories
): Promise<string> {
    console.log(`gemini.ts: Entered processDocumentWithGemini() for sender [${senderId}]. Document: ${documentFilePath}, Type: ${documentMimeType}, Prompt: "${textPrompt}"`);
    const currentHistory: ChatHistoryItem[] = chatHistories[senderId] || [];
    // Similar implementation to processImageWithGemini, adapted for document
    try {
        const uploadedFile = await aiClient.files.upload({ file: documentFilePath, config: { mimeType: documentMimeType } });
        console.log(`gemini.ts: Document file uploaded for [${senderId}]. URI: ${uploadedFile.uri}, MIME Type: ${uploadedFile.mimeType}, Name: ${uploadedFile.name}`);
        if (!uploadedFile.uri || typeof uploadedFile.uri !== 'string' || !uploadedFile.mimeType || typeof uploadedFile.mimeType !== 'string') {
            console.error(`gemini.ts: Invalid uploaded file response for document [${senderId}].`); return '';
        }
        const messageContentToSend: Part[] = [createPartFromUri(uploadedFile.uri, uploadedFile.mimeType), { text: textPrompt }];
        const userHistoryPartsToLog: ChatMessagePart[] = [{ fileData: { mimeType: documentMimeType, fileUri: uploadedFile.uri } }, { text: textPrompt }];
        const { modelResponseText, userHistoryEntry, modelHistoryEntry } = await _performGeminiChatInteraction(aiClient, senderId, currentHistory, messageContentToSend, userHistoryPartsToLog);
        if (modelResponseText && userHistoryEntry && modelHistoryEntry) {
            currentHistory.push(userHistoryEntry, modelHistoryEntry);
            chatHistories[senderId] = currentHistory;
            console.log(`gemini.ts: Updated history for [${senderId}] after document processing:`, JSON.stringify(chatHistories[senderId], null, 2));
        }
        return modelResponseText;
    } catch (error) {
        console.error(`gemini.ts: An error occurred while processing document with Gemini for [${senderId}]:`, error);
        if (error instanceof Error) {
            console.error(`  Error Type: ${error.constructor.name}`);
            console.error(`  Error Name: ${error.name}`);
            console.error(`  Error Message: ${error.message}`);
            if (error.stack) {
                console.error(`  Stack Trace:\n${error.stack}`);
            }
        } else {
            console.error('  An unknown or non-standard error object was caught in document processing for [${senderId}]:', error);
        }
        return '';
    } finally {
        console.log(`gemini.ts: processDocumentWithGemini() function execution finished for [${senderId}].`);
    }
} 