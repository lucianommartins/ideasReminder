/**
 * @file gauth.ts
 * @description This module handles all Google authentication, token management,
 * and Google People API interactions. It provides a clean interface for other
 * components to get an authenticated client without needing to know the details
 * of the OAuth2 flow. It interacts directly with Firestore for all token storage.
 */

import { OAuth2Client } from 'google-auth-library';
import { google } from 'googleapis';
import { StoredToken } from '../types/chat';
import { saveToken, deleteToken, loadToken } from './firestore';

// --- UTILITY FUNCTIONS ---

function getOAuthClient(): OAuth2Client {
    const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI } = process.env;

    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) {
        console.error("gauth.ts: Missing Google OAuth2 credentials in environment variables.");
        throw new Error("Google OAuth2 client configuration is incomplete.");
    }

    return new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
}


// --- PUBLIC AUTHENTICATION FUNCTIONS ---

export function initiateGoogleAuth(senderId: string): string {
    const oauth2Client = getOAuthClient();
    const scopes = [
        'https://www.googleapis.com/auth/tasks'
    ];
    
    const url = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: scopes,
        state: senderId,
        prompt: 'consent',
    });
    
    console.log(`gauth.ts: Generated Auth URL for [${senderId}]: ${url}`);
    return url;
}

export async function handleGoogleAuthCallback(code: string, senderId: string): Promise<void> {
    const oauth2Client = getOAuthClient();
    try {
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);

        if (!tokens.access_token || !tokens.expiry_date) {
            throw new Error('Incomplete token data received from Google.');
        }
        
        const existingToken = await loadToken(senderId);

        const tokenToStore: StoredToken = {
            access_token: tokens.access_token!,
            refresh_token: tokens.refresh_token || existingToken?.refresh_token,
            scope: tokens.scope || '',
            token_type: 'Bearer',
            expiry_date: tokens.expiry_date || 0,
        };

        await saveToken(senderId, tokenToStore);
        
    } catch (error) {
        console.error(`gauth.ts: Error exchanging auth code for tokens for [${senderId}]:`, error);
        throw new Error(`Failed to get Google access token for [${senderId}].`);
    }
}

/**
 * Retrieves a fully authenticated OAuth2 client for a given user by fetching the token
 * directly from Firestore. This is the gateway for other components to perform authenticated API calls.
 * It automatically handles the token refresh logic.
 * @param senderId The user's identifier.
 * @returns A promise that resolves to a ready-to-use, authenticated OAuth2Client.
 */
export async function getAuthenticatedClient(senderId: string): Promise<OAuth2Client> {
    console.log(`gauth.ts: Fetching token for [${senderId}] directly from Firestore.`);
    const user = await loadToken(senderId);
    
    if (!user || !user.refresh_token) {
        throw new Error(`User [${senderId}] is not authenticated. Please use /connect_google.`);
    }

    const oauth2Client = getOAuthClient();
    oauth2Client.setCredentials(user);

    const isTokenExpired = Date.now() >= (user.expiry_date - 300000); // 5-min buffer

    if (isTokenExpired) {
        console.log(`gauth.ts: Token for [${senderId}] is expired. Refreshing...`);
        try {
            const { credentials } = await oauth2Client.refreshAccessToken();
            
            const updatedToken: StoredToken = {
                ...user,
                access_token: credentials.access_token!,
                scope: credentials.scope || user.scope,
                expiry_date: credentials.expiry_date!,
            };
            
            oauth2Client.setCredentials(updatedToken);
            await saveToken(senderId, updatedToken);
            console.log(`gauth.ts: Successfully refreshed and saved token for [${senderId}].`);
            
        } catch (refreshError) {
            console.error(`gauth.ts: Failed to refresh access token for [${senderId}]. Deleting token from Firestore.`, refreshError);
            await deleteToken(senderId);
            throw new Error(`Your Google connection has expired. Please reconnect.`);
        }
    }
    
    return oauth2Client;
}


// --- USER STATUS FUNCTIONS ---

/**
 * Checks if a user is authenticated by looking for a valid token in Firestore.
 * @param senderId The user's identifier.
 * @returns A promise that resolves to true if the user is authenticated.
 */
export async function isUserAuthenticated(senderId: string): Promise<boolean> {
    console.log(`gauth.ts: Checking auth status for [${senderId}] in Firestore.`);
    const user = await loadToken(senderId);
    return !!(user && user.refresh_token);
}

export async function getAuthStatus(senderId: string): Promise<string> {
    if (await isUserAuthenticated(senderId)) {
        return "You are connected to Google Tasks and ready to manage your tasks.";
    } else {
        return "You are not connected to Google. Please use the `/connect_google_tasks` command.";
    }
}

/**
 * Clears a user's token from Firestore.
 * @param senderId The user's identifier.
 * @returns A promise resolving to true if a token was found and deleted, false otherwise.
 */
export async function clearUserTokens(senderId: string): Promise<boolean> {
    try {
        const userExists = await isUserAuthenticated(senderId);
        if (userExists) {
            await deleteToken(senderId);
            console.log(`gauth.ts: Successfully cleared tokens for user [${senderId}] from Firestore.`);
        } else {
            console.log(`gauth.ts: No tokens found to clear in Firestore for user [${senderId}].`);
        }
        return userExists;
    } catch (error) {
        console.error(`gauth.ts: Error clearing tokens for user [${senderId}].`, error);
        return false;
    }
}
