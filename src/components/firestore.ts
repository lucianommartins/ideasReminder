/**
 * @file firestore.ts
 * @description This module centralizes all interactions with Google Cloud Firestore.
 * It provides a clean, reusable interface for other components to interact with the database
 * without needing to know the implementation details (collection names, etc.).
 */

import { Firestore } from '@google-cloud/firestore';
import { StoredToken, UserTokens } from '../types/chat';

// --- CONSTANTS ---
const GOOGLE_TOKENS_COLLECTION = 'google-tokens';
const RETURNING_USERS_COLLECTION = 'returning-users';

// --- FIRESTORE INITIALIZATION ---
// Initialize the Firestore client. The `databaseId` points to our specific database.
const firestore = new Firestore({
    databaseId: 'voicetasks-db',
});
console.log('firestore.ts: Firestore client initialized for database "voicetasks-db".');

/**
 * Removes properties with 'undefined' values from an object.
 * Firestore throws an error if you try to save 'undefined'.
 * @param obj The object to clean.
 * @returns A new object with 'undefined' properties removed.
 */
function cleanupObject(obj: any): any {
    const newObj: any = {};
    for (const key in obj) {
        if (obj[key] !== undefined) {
            newObj[key] = obj[key];
        }
    }
    return newObj;
}

// --- TOKEN MANAGEMENT FUNCTIONS ---

/**
 * Saves a user's Google OAuth2 token to Firestore.
 * @param senderId The user's unique identifier.
 * @param token The StoredToken object to save.
 */
export async function saveToken(senderId: string, token: StoredToken): Promise<void> {
    console.log(`firestore.ts: Saving token for user [${senderId}] to Firestore.`);
    try {
        const docRef = firestore.collection(GOOGLE_TOKENS_COLLECTION).doc(senderId);
        const cleanToken = cleanupObject(token);
        await docRef.set(cleanToken);
        console.log(`firestore.ts: Successfully saved token for user [${senderId}].`);
    } catch (error) {
        console.error(`firestore.ts: Error saving token for user [${senderId}].`, error);
        throw error; // Re-throw to allow the caller to handle it.
    }
}

/**
 * Loads a single user's token from Firestore.
 * @param senderId The user's identifier.
 * @returns The user's token object, or null if it's not found.
 */
export async function loadToken(senderId: string): Promise<StoredToken | null> {
    console.log(`firestore.ts: Fetching token for user [${senderId}] from Firestore.`);
    try {
        const docRef = firestore.collection(GOOGLE_TOKENS_COLLECTION).doc(senderId);
        const doc = await docRef.get();
        if (doc.exists) {
            console.log(`firestore.ts: Found token for user [${senderId}].`);
            return doc.data() as StoredToken;
        }
        console.log(`firestore.ts: No token found for user [${senderId}].`);
        return null;
    } catch (error) {
        console.error(`firestore.ts: Error fetching token for user [${senderId}].`, error);
        throw error;
    }
}

/**
 * Deletes a user's token from Firestore.
 * @param senderId The user's identifier.
 */
export async function deleteToken(senderId: string): Promise<void> {
    console.log(`firestore.ts: Deleting token for user [${senderId}] from Firestore.`);
    try {
        const docRef = firestore.collection(GOOGLE_TOKENS_COLLECTION).doc(senderId);
        await docRef.delete();
        console.log(`firestore.ts: Successfully deleted token for user [${senderId}].`);
    } catch (error) {
        console.error(`firestore.ts: Error deleting token for user [${senderId}].`, error);
        throw error;
    }
}

// --- USER MANAGEMENT FUNCTIONS ---

/**
 * Checks if a user exists in the 'returning-users' collection in Firestore.
 * This is used to identify new vs. returning users.
 * @param senderId The unique ID of the user.
 * @returns A boolean indicating if the user is a returning user.
 */
export async function isReturningUser(senderId: string): Promise<boolean> {
    try {
        const userDocRef = firestore.collection(RETURNING_USERS_COLLECTION).doc(senderId);
        const doc = await userDocRef.get();
        return doc.exists;
    } catch (error) {
        // If the database check fails, we conservatively assume it's a new user
        // to avoid blocking the welcome message flow.
        console.error(`firestore.ts: Error checking for returning user [${senderId}]. Assuming new user.`, error);
        return false;
    }
}

/**
 * Adds a new user's ID to the 'returning-users' collection in Firestore.
 * This is typically called on a user's first interaction.
 * @param senderId The unique ID of the new user to add.
 */
export async function addNewUser(senderId: string): Promise<void> {
    try {
        const userDocRef = firestore.collection(RETURNING_USERS_COLLECTION).doc(senderId);
        // We use .set() with a timestamp. The existence of the document is what matters for
        // the isReturningUser check, but storing the join date could be useful later.
        await userDocRef.set({ joinedAt: new Date().toISOString() });
        console.log(`firestore.ts: Successfully added new user [${senderId}] to collection '${RETURNING_USERS_COLLECTION}'.`);
    } catch (error) {
        console.error(`firestore.ts: Failed to add new user [${senderId}] to Firestore.`, error);
        throw error;
    }
} 