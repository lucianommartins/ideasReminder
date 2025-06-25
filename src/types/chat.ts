// src/types/chat.ts

// Defines the structure for a single part of a message in the chat history
export interface ChatMessagePart {
    text: string;
    // Add other part types if needed in the future, e.g., inlineData
}

// Defines a single message turn in the chat history (either from user or model)
export interface ChatHistoryItem {
    role: "user" | "model";
    parts: ChatMessagePart[];
}

// Defines the structure for storing chat histories for multiple users
// The key is the senderId (string), and the value is an array of ChatHistoryItem
export type ChatHistories = Record<string, ChatHistoryItem[]>; 