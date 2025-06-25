import { GoogleGenAI, createUserContent, createPartFromUri } from "@google/genai";
import { ChatHistoryItem, ChatHistories } from "../types/chat";

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
        console.log(`gemini.ts: Creating/continuing chat session for [${senderId}] with model gemini-2.5-flash and thinkingBudget: 0.`);
        const chat = aiClient.chats.create({
            model: "gemini-2.5-flash",
            history: currentHistory,
            config: {
                thinkingConfig: {
                    thinkingBudget: 0,
                },
            }
        });

        console.log(`gemini.ts: Sending message to Gemini for [${senderId}]: "${newUserMessage}"`);
        const response = await chat.sendMessage({
            message: newUserMessage,
        });

        const modelResponseText = response.text ? response.text.trim() : '';

        if (modelResponseText) {
            console.log(`gemini.ts: Successfully generated text from Gemini for [${senderId}]: "${modelResponseText}"`);
            currentHistory.push({ role: "user", parts: [{ text: newUserMessage }] });
            currentHistory.push({ role: "model", parts: [{ text: modelResponseText }] });
            chatHistories[senderId] = currentHistory;
            console.log(`gemini.ts: Updated history for [${senderId}]:`, JSON.stringify(chatHistories[senderId], null, 2));
        } else {
            console.warn(`gemini.ts: Gemini API returned empty text for [${senderId}].`);
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
 * Processes an audio file with Gemini using a fixed prompt.
 * @param aiClient The initialized GoogleGenAI client instance.
 * @param audioFilePath Path to the local audio file.
 * @param audioMimeType MIME type of the audio file (e.g., "audio/ogg", "audio/mpeg").
 * @param textPrompt The fixed text prompt to send along with the audio.
 * @returns A promise that resolves to the generated text response, or an empty string if an error occurs.
 */
export async function processAudioWithGemini(
    aiClient: GoogleGenAI,
    audioFilePath: string,
    audioMimeType: string,
    textPrompt: string
): Promise<string> {
    console.log(`gemini.ts: Entered processAudioWithGemini(). Audio: ${audioFilePath}, Type: ${audioMimeType}, Prompt: "${textPrompt}"`);
    try {
        console.log(`gemini.ts: Uploading audio file [${audioFilePath}] to Gemini...`);
        const uploadedFile = await aiClient.files.upload({
            file: audioFilePath,
            config: { mimeType: audioMimeType },
        });
        console.log(`gemini.ts: Audio file uploaded to Gemini. URI: ${uploadedFile.uri}, MIME Type: ${uploadedFile.mimeType}, Name: ${uploadedFile.name}`);

        if (!uploadedFile.uri || typeof uploadedFile.uri !== 'string') {
            console.error('gemini.ts: Uploaded file response from Gemini is missing a valid URI.');
            return '';
        }
        if (!uploadedFile.mimeType || typeof uploadedFile.mimeType !== 'string') {
            console.error('gemini.ts: Uploaded file response from Gemini is missing a valid MIME type.');
            return '';
        }

        const singleTurnContent = createUserContent([
            createPartFromUri(uploadedFile.uri, uploadedFile.mimeType),
            textPrompt,
        ]);

        console.log('gemini.ts: Sending multimodal content (audio + prompt) to Gemini model gemini-2.5-flash...');
        const response = await aiClient.models.generateContent({
            model: "gemini-2.5-flash",
            contents: [singleTurnContent],
            config: {
                thinkingConfig: {
                    thinkingBudget: 0,
                },
            }
        });

        const responseText = response.text ? response.text.trim() : '';
        if (responseText) {
            console.log(`gemini.ts: Successfully generated text from audio + prompt: "${responseText}"`);
        } else {
            console.warn('gemini.ts: Gemini API returned empty text for audio + prompt processing.');
        }
        
        return responseText;

    } catch (error) {
        console.error('gemini.ts: An error occurred while processing audio with Gemini:', error);
        if (error instanceof Error) {
            console.error(`  Error Type: ${error.constructor.name}`);
            console.error(`  Error Name: ${error.name}`);
            console.error(`  Error Message: ${error.message}`);
            if (error.stack) {
                console.error(`  Stack Trace:\n${error.stack}`);
            }
        } else {
            console.error('  An unknown or non-standard error object was caught in audio processing:', error);
        }
        return '';
    } finally {
        console.log('gemini.ts: processAudioWithGemini() function execution finished.');
    }
} 