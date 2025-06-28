/**
 * @file gauth.ts
 * @description This module handles all Google authentication, token management,
 * and Google People API interactions. It provides a clean interface for other
 * components to get an authenticated client without needing to know the details
 * of the OAuth2 flow.
 */

import { OAuth2Client } from 'google-auth-library';
import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import { UserTokens, StoredToken } from '../types/chat';

// --- CONSTANTS ---
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const TOKEN_FILE_PATH = path.join(DATA_DIR, 'google_tokens.json');

// --- IN-MEMORY TOKEN CACHE ---
let userTokens: UserTokens = {};

// --- PRIVATE UTILITY FUNCTIONS ---

function ensureDataDirectoryExists(): void {
    if (!fs.existsSync(DATA_DIR)) {
        console.log(`gauth.ts: Data directory does not exist. Creating: ${DATA_DIR}`);
        try {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        } catch (error) {
            console.error(`gauth.ts: FATAL: Failed to create data directory ${DATA_DIR}.`, error);
        }
    }
}

function loadTokensFromFile(): UserTokens {
    ensureDataDirectoryExists();
    if (fs.existsSync(TOKEN_FILE_PATH)) {
        try {
            const data = fs.readFileSync(TOKEN_FILE_PATH, 'utf8');
            const loadedTokens = JSON.parse(data) as UserTokens;
            console.log(`gauth.ts: Tokens successfully loaded. User count: ${Object.keys(loadedTokens).length}`);
            return loadedTokens;
        } catch (error) {
            console.error(`gauth.ts: Failed to load or parse tokens file. Starting with empty tokens.`, error);
        }
    }
    return {};
}

function saveTokensToFile(tokens: UserTokens): void {
    ensureDataDirectoryExists();
    try {
        const data = JSON.stringify(tokens, null, 2);
        fs.writeFileSync(TOKEN_FILE_PATH, data, 'utf8');
    } catch (error) {
        console.error(`gauth.ts: Error saving tokens to file.`, error);
    }
}

userTokens = loadTokensFromFile();

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
        'openid',
        'https://www.googleapis.com/auth/userinfo.profile',
        'https://www.googleapis.com/auth/user.addresses.read',
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
        
        let userCountry: string | undefined = undefined;
        
        try {
            const peopleService = google.people({ version: 'v1', auth: oauth2Client });
            
            const profileResponse = await peopleService.people.get({
                resourceName: 'people/me',
                personFields: 'addresses',
            });

            console.log('\n--- DIAGNOSTIC: Full response.data from people.get ---');
            console.log(JSON.stringify(profileResponse.data, null, 2));

            const addresses = profileResponse.data.addresses;
            if (addresses && addresses.length > 0) {
                const primaryAddress = addresses.find(addr => addr.metadata?.primary) || addresses[0];
                userCountry = (primaryAddress as any).countryCode || undefined;
            }
            console.log(`\n(Attempt) Extracted country from the response: ${userCountry}`);

        } catch (infoError) {
            console.error(`\n---! ERROR DURING people.get FETCH !---`, infoError);
        }

        userTokens[senderId] = {
            access_token: tokens.access_token!,
            refresh_token: tokens.refresh_token || undefined,
            scope: tokens.scope || '',
            token_type: 'Bearer',
            expiry_date: tokens.expiry_date || 0,
            locale: undefined,
            country: userCountry,
        };

        saveTokensToFile(userTokens);
        
    } catch (error) {
        console.error(`gauth.ts: Error exchanging auth code for tokens for [${senderId}]:`, error);
        throw new Error(`Failed to get Google access token for [${senderId}].`);
    }
}

/**
 * Retrieves a fully authenticated OAuth2 client for a given user.
 * This is the gateway for other components to perform authenticated API calls.
 * It automatically handles the token refresh logic.
 * @param senderId The user's identifier.
 * @returns A promise that resolves to a ready-to-use, authenticated OAuth2Client.
 */
export async function getAuthenticatedClient(senderId: string): Promise<OAuth2Client> {
    const user = userTokens[senderId];
    if (!user || !user.refresh_token) {
        throw new Error(`User [${senderId}] is not authenticated. Please use /connect_google.`);
    }

    const oauth2Client = getOAuthClient();
    oauth2Client.setCredentials(user);

    const isTokenExpired = Date.now() >= (user.expiry_date - 300000); // 5-min buffer

    if (isTokenExpired) {
        try {
            const { credentials } = await oauth2Client.refreshAccessToken();
            
            userTokens[senderId] = {
                ...user,
                access_token: credentials.access_token!,
                scope: credentials.scope || user.scope,
                expiry_date: credentials.expiry_date!,
            };
            
            oauth2Client.setCredentials(userTokens[senderId]);
            saveTokensToFile(userTokens);
            
        } catch (refreshError) {
            console.error(`gauth.ts: Failed to refresh access token for [${senderId}].`, refreshError);
            delete userTokens[senderId];
            saveTokensToFile(userTokens);
            throw new Error(`Your Google connection has expired. Please reconnect.`);
        }
    }
    
    return oauth2Client;
}


// --- USER STATUS FUNCTIONS ---

export function isUserAuthenticated(senderId: string): boolean {
    const user = userTokens[senderId];
    return !!(user && user.refresh_token);
}

export async function getAuthStatus(senderId: string): Promise<string> {
    if (!isUserAuthenticated(senderId)) {
        return "You are not connected to Google. Please use the `/connect_google` command.";
    }
    try {
        const oauth2Client = await getAuthenticatedClient(senderId);
        const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
        const userInfo = await oauth2.userinfo.get();
        return `You are connected to Google as ${userInfo.data.name} (${userInfo.data.email}). Your country is set to: ${userTokens[senderId].country || 'Not Found'}.`;
    } catch (error: any) {
        return `You are connected to Google, but there was an error fetching your info: ${error.message}`;
    }
}

export function clearUserTokens(senderId: string): boolean {
    if (userTokens[senderId]) {
        delete userTokens[senderId];
        saveTokensToFile(userTokens);
        console.log(`gauth.ts: Cleared tokens for user [${senderId}].`);
        return true;
    }
    return false;
} 