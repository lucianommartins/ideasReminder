/**
 * @file gauth.ts
 * @description This module centralizes all Google authentication and token management.
 * It provides a clean interface for other components to get an authenticated OAuth2 client
 * without needing to know the details of the OAuth2 flow or token storage.
 * It uses Firestore for all token persistence.
 */

import { OAuth2Client } from 'google-auth-library';
import { StoredToken } from '../types/chat';
import { saveToken, deleteToken, loadToken } from './firestore';

/**
 * Creates and configures an OAuth2Client instance using environment variables.
 * @returns {OAuth2Client} A configured Google OAuth2 client.
 * @throws {Error} If essential OAuth2 environment variables are missing.
 */
function getOAuthClient(): OAuth2Client {
    const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI } = process.env;

    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) {
        console.error("gauth.ts: Missing Google OAuth2 credentials in environment variables.");
        throw new Error("Google OAuth2 client configuration is incomplete.");
    }

    return new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
}

// --- PUBLIC AUTHENTICATION FUNCTIONS ---

/**
 * Generates the Google authentication URL for the user to visit.
 * @param senderId The user's unique identifier, used as the 'state' parameter for security.
 * @returns The generated authentication URL.
 */
export function initiateGoogleAuth(senderId: string): string {
    const oauth2Client = getOAuthClient();
    const scopes = [
        'https://www.googleapis.com/auth/tasks' // Scope for Google Tasks API
    ];
    
    // The 'state' parameter is crucial for linking the auth flow back to the correct user.
    const url = oauth2Client.generateAuthUrl({
        access_type: 'offline', // Required to get a refresh_token
        scope: scopes,
        state: senderId,
        prompt: 'consent',      // Ensures the user is prompted for consent every time
    });
    
    console.log(`gauth.ts: Generated Auth URL for [${senderId}].`);
    return url;
}

/**
 * Handles the callback from Google after the user grants permission.
 * It exchanges the authorization code for tokens and saves them to Firestore.
 * @param code The authorization code from Google.
 * @param senderId The user's identifier from the 'state' parameter.
 */
export async function handleGoogleAuthCallback(code: string, senderId: string): Promise<void> {
    const oauth2Client = getOAuthClient();
    try {
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);

        if (!tokens.access_token || !tokens.expiry_date) {
            throw new Error('Incomplete token data received from Google.');
        }
        
        const existingToken = await loadToken(senderId);

        // We must preserve the refresh_token if it's not in the new response.
        const tokenToStore: StoredToken = {
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token || existingToken?.refresh_token,
            scope: tokens.scope || '',
            token_type: 'Bearer',
            expiry_date: tokens.expiry_date,
        };

        await saveToken(senderId, tokenToStore);
        
    } catch (error) {
        console.error(`gauth.ts: Error exchanging auth code for tokens for [${senderId}]:`, error);
        throw new Error(`Failed to get Google access token for [${senderId}].`);
    }
}

/**
 * Retrieves a fully authenticated OAuth2 client for a given user.
 * This is the primary function used by other components to interact with Google APIs.
 * It automatically handles token loading and refreshing.
 * @param senderId The user's identifier.
 * @returns A promise that resolves to a ready-to-use, authenticated OAuth2Client.
 * @throws {Error} If the user is not authenticated or if the token refresh fails.
 */
export async function getAuthenticatedClient(senderId: string): Promise<OAuth2Client> {
    const userToken = await loadToken(senderId);
    
    if (!userToken || !userToken.refresh_token) {
        throw new Error(`User [${senderId}] is not authenticated. Please use the /connect_google_tasks command.`);
    }

    const oauth2Client = getOAuthClient();
    oauth2Client.setCredentials(userToken);

    // Refresh the token if it's about to expire (within a 5-minute buffer).
    const isTokenExpired = Date.now() >= (userToken.expiry_date - 300000); 

    if (isTokenExpired) {
        console.log(`gauth.ts: Token for [${senderId}] is expired. Refreshing...`);
        try {
            const { credentials } = await oauth2Client.refreshAccessToken();
            
            // Merge the new credentials with the existing token, keeping the refresh_token.
            const updatedToken: StoredToken = {
                ...userToken,
                access_token: credentials.access_token!,
                scope: credentials.scope || userToken.scope,
                expiry_date: credentials.expiry_date!,
            };
            
            oauth2Client.setCredentials(updatedToken);
            await saveToken(senderId, updatedToken);
            console.log(`gauth.ts: Successfully refreshed and saved token for [${senderId}].`);
            
        } catch (refreshError) {
            console.error(`gauth.ts: Failed to refresh access token for [${senderId}]. Deleting token.`, refreshError);
            await deleteToken(senderId); // Clean up the invalid token
            throw new Error(`Your Google connection has expired or been revoked. Please reconnect using /connect_google_tasks.`);
        }
    }
    
    return oauth2Client;
}

// --- USER STATUS FUNCTIONS ---

/**
 * Checks if a user is authenticated by verifying the existence of a refresh token in Firestore.
 * @param senderId The user's identifier.
 * @returns A promise resolving to true if the user is authenticated, otherwise false.
 */
export async function isUserAuthenticated(senderId: string): Promise<boolean> {
    const userToken = await loadToken(senderId);
    return !!(userToken && userToken.refresh_token);
}

/**
 * Provides a user-friendly message about the user's current authentication status.
 * @param senderId The user's identifier.
 * @returns A promise resolving to a status message string.
 */
export async function getAuthStatus(senderId: string): Promise<string> {
    if (await isUserAuthenticated(senderId)) {
        return "You are connected to Google Tasks and ready to manage your tasks.";
    } else {
        return "You are not connected to Google. Please use the `/connect_google_tasks` command.";
    }
}

/**
 * Deletes a user's token from Firestore, effectively disconnecting them.
 * @param senderId The user's identifier.
 * @returns A promise resolving to true if a token was found and deleted, false otherwise.
 */
export async function clearUserTokens(senderId: string): Promise<boolean> {
    try {
        const userExists = await isUserAuthenticated(senderId);
        if (userExists) {
            await deleteToken(senderId);
            console.log(`gauth.ts: Successfully cleared token for user [${senderId}].`);
        } else {
            console.log(`gauth.ts: No token found to clear for user [${senderId}].`);
        }
        return userExists;
    } catch (error) {
        console.error(`gauth.ts: Error clearing token for user [${senderId}].`, error);
        return false;
    }
}
