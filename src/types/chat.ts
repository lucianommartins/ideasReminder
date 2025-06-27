/**
 * @file chat.ts
 * @description This file defines the core data structures and types used throughout the application,
 * including structures for managing chat history with the Gemini API and for storing
 * Google OAuth tokens for the Google Tasks integration.
 */

// Defines the source of file data
export interface FileDataSource {
    mimeType: string;
    fileUri: string;
}

// Defines the structure for a single part of a message in the chat history
// A part can be either text or file data, but not both.
export type ChatMessagePart = 
    | { text: string; fileData?: never; }          // Text part
    | { text?: never; fileData: FileDataSource; }; // File data part

// Defines a single message turn in the chat history (either from user or model)
export interface ChatHistoryItem {
    role: "user" | "model";
    parts: ChatMessagePart[];
}

// Defines the structure for storing chat histories for multiple users
// The key is the senderId (string), and the value is an array of ChatHistoryItem
export type ChatHistories = Record<string, ChatHistoryItem[]>;

// --- Types for Task Identification ---

/**
 * Represents the structured details of a task identified by the Gemini model.
 * This is the structure the model is prompted to return as JSON.
 */
export interface IdentifiedTask {
    isTask: true;
    details: {
        objective: string;      // The main, concise goal of the task.
        description: string;    // A more detailed description.
        final_result: string;   // The expected outcome or deliverable.
        user_experience: string // How this task impacts the user experience.
    };
}

// --- Types for Google API Tokens ---

/**
 * Represents the structure of the OAuth2 token object stored for a single user.
 * This includes the access token for API calls, the refresh token for obtaining new
 * access tokens, the scope of permissions, and the token's expiry date.
 */
export interface StoredToken {
    access_token: string;
    /**
     * The refresh token is optional because it is only sent by Google on the very first
     * authorization consent from the user. Subsequent exchanges will not include it.
     * It is crucial for long-term, offline access.
     */
    refresh_token?: string;
    scope: string;
    token_type: 'Bearer';
    /**
     * The timestamp (in milliseconds since the epoch) when the access_token expires.
     */
    expiry_date: number;
}

/**
 * A record mapping a user's unique senderId to their stored Google API token.
 * This serves as the in-memory cache and the structure for the persisted JSON file.
 */
export interface UserTokens {
    [senderId: string]: StoredToken;
} 