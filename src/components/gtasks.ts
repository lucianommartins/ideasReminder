/**
 * @file gtasks.ts
 * @description This module handles all interactions with the Google Tasks API.
 * It manages OAuth2 authentication, token storage, token refresh, and provides
 * functions to perform CRUD operations on Google Tasks and Task Lists.
 * Tokens are persisted to a JSON file in the `src/data` directory.
 */

import { OAuth2Client } from 'google-auth-library';
import { tasks_v1, google } from 'googleapis'; // For Tasks API
import fs from 'fs'; // Node.js File System module
import path from 'path'; // Node.js Path module
import { UserTokens, StoredToken, IdentifiedTask } from '../types/chat';

// --- CONSTANTS ---
const DATA_DIR = path.resolve(__dirname, '..', 'data'); // Resolves to <project_root>/src/data
const TOKEN_FILE_PATH = path.join(DATA_DIR, 'google_tokens.json');

// --- Configuration (loaded from process.env in index.ts and passed or accessed here) ---
// const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
// const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
// const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;

// --- IN-MEMORY TOKEN CACHE ---
let userTokens: UserTokens = {};

// --- PRIVATE UTILITY FUNCTIONS ---

/**
 * Ensures that the data directory for storing tokens exists.
 * If it doesn't, it attempts to create it.
 */
function ensureDataDirectoryExists(): void {
    if (!fs.existsSync(DATA_DIR)) {
        console.log(`gtasks.ts: Data directory does not exist. Creating: ${DATA_DIR}`);
        try {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        } catch (error) {
            console.error(`gtasks.ts: FATAL: Failed to create data directory ${DATA_DIR}. Token persistence will fail.`, error);
            // This is a critical failure. Depending on requirements, we might throw or exit.
            // For now, we log it as a fatal error.
        }
    }
}

/**
 * Loads tokens from the persistent JSON file into the in-memory cache.
 * @returns The UserTokens object loaded from the file, or an empty object if it fails.
 */
function loadTokensFromFile(): UserTokens {
    ensureDataDirectoryExists();
    if (fs.existsSync(TOKEN_FILE_PATH)) {
        try {
            const data = fs.readFileSync(TOKEN_FILE_PATH, 'utf8');
            const loadedTokens = JSON.parse(data) as UserTokens;
            console.log(`gtasks.ts: Tokens successfully loaded. User count: ${Object.keys(loadedTokens).length}`);
            return loadedTokens;
        } catch (error) {
            console.error(`gtasks.ts: Failed to load or parse tokens file. Starting with empty tokens.`, error);
        }
    }
    return {};
}

/**
 * Saves the provided UserTokens object to the persistent JSON file.
 * @param tokens The complete UserTokens object to save.
 */
function saveTokensToFile(tokens: UserTokens): void {
    ensureDataDirectoryExists();
    try {
        const data = JSON.stringify(tokens, null, 2); // Pretty-print JSON
        fs.writeFileSync(TOKEN_FILE_PATH, data, 'utf8');
    } catch (error) {
        console.error(`gtasks.ts: Error saving tokens to file.`, error);
    }
}

// Initialize the in-memory token cache from the file at startup.
userTokens = loadTokensFromFile();

/**
 * Creates and configures a Google OAuth2 client instance.
 * @returns An configured OAuth2Client instance.
 * @throws An error if essential Google Cloud credentials are not found in environment variables.
 */
function getOAuthClient(): OAuth2Client {
    const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI } = process.env;

    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) {
        console.error("gtasks.ts: Missing Google OAuth2 credentials or redirect URI in environment variables.");
        throw new Error("Google OAuth2 client configuration is incomplete. Please check server environment variables.");
    }

    return new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
}

// --- PUBLIC AUTHENTICATION FUNCTIONS ---

/**
 * Generates the Google OAuth2 consent URL for the user to visit to authorize the application.
 * @param senderId The user's unique identifier (e.g., WhatsApp number), used to link the auth flow back to the user.
 * @returns The fully formed authorization URL.
 */
export function initiateGoogleAuth(senderId: string): string {
    const oauth2Client = getOAuthClient();
    const scopes = ['https://www.googleapis.com/auth/tasks'];
    
    const url = oauth2Client.generateAuthUrl({
        access_type: 'offline', // Crucial for obtaining a refresh_token for long-term access.
        scope: scopes,
        state: senderId,        // Pass senderId through the flow to identify the user in the callback.
        prompt: 'consent',      // Ensures the user is prompted for consent, which helps in issuing a refresh_token.
    });
    
    return url;
}

/**
 * Handles the OAuth2 callback from Google. It exchanges the authorization code for tokens.
 * @param code The authorization code received from Google in the callback query parameters.
 * @param senderId The user's identifier, retrieved from the 'state' query parameter.
 * @throws An error if the token exchange fails or if essential tokens are not received.
 */
export async function handleGoogleAuthCallback(code: string, senderId: string): Promise<void> {
    const oauth2Client = getOAuthClient();
    try {
        const { tokens } = await oauth2Client.getToken(code);

        if (!tokens.refresh_token) {
            console.warn(`gtasks.ts: No refresh_token received for [${senderId}]. This can happen if the user has already granted consent and the 'prompt' parameter was not 'consent'. The user may need to re-authenticate if offline access expires.`);
        }
        
        if (!tokens.access_token || !tokens.expiry_date) {
            throw new Error('Incomplete token data received from Google during auth code exchange.');
        }

        userTokens[senderId] = {
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token || undefined,
            scope: tokens.scope!,
            token_type: 'Bearer',
            expiry_date: tokens.expiry_date,
        };

        saveTokensToFile(userTokens);
        
    } catch (error) {
        console.error(`gtasks.ts: Error exchanging auth code for tokens for [${senderId}]:`, error);
        throw new Error(`Failed to get Google Tasks access token for [${senderId}].`);
    }
}

/**
 * Retrieves a fully authenticated OAuth2 client for a given user.
 * This function is the gateway for all authenticated API calls. It automatically
 * handles the token refresh logic if the access token is expired.
 * @param senderId The user's identifier.
 * @returns A promise that resolves to a ready-to-use, authenticated OAuth2Client.
 * @throws An error if the user is not authenticated or if the token refresh fails.
 */
async function getAuthenticatedClient(senderId: string): Promise<OAuth2Client> {
    const user = userTokens[senderId];
    if (!user || !user.refresh_token) {
        throw new Error(`User [${senderId}] is not authenticated or session is invalid. Please use /connect_google_tasks.`);
    }

    const oauth2Client = getOAuthClient();
    oauth2Client.setCredentials(user);

    // Check if the token is expired or close to expiring (e.g., within the next 5 minutes).
    // The google-auth-library can handle this automatically on an API call, but an explicit
    // check provides clearer logic and error handling.
    const isTokenExpired = Date.now() >= (user.expiry_date - 300000); // 5-minute buffer

    if (isTokenExpired) {
        try {
            const { credentials } = await oauth2Client.refreshAccessToken();
            
            userTokens[senderId] = {
                ...user, // Preserve existing properties like the original refresh_token
                access_token: credentials.access_token!,
                scope: credentials.scope || user.scope,
                expiry_date: credentials.expiry_date!,
            };
            
            oauth2Client.setCredentials(userTokens[senderId]);
            saveTokensToFile(userTokens);
            
        } catch (refreshError) {
            console.error(`gtasks.ts: Failed to refresh access token for [${senderId}]. The refresh token may be revoked.`, refreshError);
            delete userTokens[senderId];
            saveTokensToFile(userTokens);
            throw new Error(`Your Google connection has expired and could not be refreshed. Please reconnect using /connect_google_tasks.`);
        }
    }
    
    return oauth2Client;
}

// --- PUBLIC API FUNCTIONS ---

/**
 * Lists the authenticated user's task lists.
 * @param senderId The user's identifier.
 * @returns A promise that resolves to an array of task lists or an error message string for user display.
 */
export async function listTaskLists(senderId: string): Promise<tasks_v1.Schema$TaskList[] | string> {
    try {
        const oauth2Client = await getAuthenticatedClient(senderId);
        const tasksService = google.tasks({ version: 'v1', auth: oauth2Client });
        const response = await tasksService.tasklists.list({ maxResults: 25 });
        return response.data.items || [];
    } catch (error: any) {
        console.error(`gtasks.ts: Error listing task lists for [${senderId}]:`, error.message);
        return `Error fetching Google Task lists: ${error.message}`;
    }
}

/**
 * Lists tasks within a specific task list for the authenticated user.
 * @param senderId The user's identifier.
 * @param tasklistId The ID of the task list (defaults to '@default').
 * @returns A promise that resolves to an array of tasks or an error message string for user display.
 */
export async function getTasksInList(senderId: string, tasklistId: string = '@default'): Promise<tasks_v1.Schema$Task[] | string> {
    try {
        const oauth2Client = await getAuthenticatedClient(senderId);
        const tasksService = google.tasks({ version: 'v1', auth: oauth2Client });
        const response = await tasksService.tasks.list({
            tasklist: tasklistId,
            showCompleted: false,
            showHidden: false,
            maxResults: 50,
        });
        return response.data.items || [];
    } catch (error: any) {
        console.error(`gtasks.ts: Error listing tasks in list [${tasklistId}] for [${senderId}]:`, error.message);
        return `Error fetching tasks for list ID '${tasklistId}': ${error.message}`;
    }
}

/**
 * Creates a new, detailed task in the user's default task list.
 * @param senderId The user's identifier.
 * @param taskDetails The structured task details from Gemini.
 * @param tasklistId The ID of the task list where the task will be added. Defaults to '@default'.
 * @returns A promise that resolves to the created task object or an error message string for user display.
 */
export async function createGoogleTask(
    senderId: string,
    taskDetails: IdentifiedTask['details'],
    tasklistId: string = '@default'
): Promise<tasks_v1.Schema$Task | string> {
    try {
        const oauth2Client = await getAuthenticatedClient(senderId);
        const tasksService = google.tasks({ version: 'v1', auth: oauth2Client });

        // --- Task Timing & Recurrence ---
        // Set the timezone for the task. IMPORTANT: This is a fixed timezone.
        // The bot cannot know the user's local timezone automatically.
        const TIMEZONE = 'America/Sao_Paulo';

        // Calculate the due date: Tomorrow at 9 AM in the specified timezone.
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(9, 0, 0, 0);

        // Format for Google Tasks API (RFC 3339 timestamp).
        // We need to construct the date string manually to ensure the correct timezone offset.
        // The toISOString() method always uses UTC (Z), which we don't want here.
        // A library like date-fns-tz would be ideal, but to keep dependencies low, we do it manually.
        // This is a simplified approach. For full accuracy across all timezones and DST changes,
        // a dedicated library would be better.
        const offset = new Date().getTimezoneOffset() / -60; // Example for manual offset
        const pad = (num: number) => (num < 10 ? '0' : '') + num;
        const dueDateTime = `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}T${pad(tomorrow.getHours())}:${pad(tomorrow.getMinutes())}:${pad(tomorrow.getSeconds())}.000${offset >= 0 ? '+' : '-'}${pad(Math.abs(offset))}:00`;

        const recurrenceRule = 'RRULE:FREQ=DAILY;COUNT=3'; // Repeat daily for 3 days.

        // --- Construct Task Body ---
        // Combine the structured details into a comprehensive task description.
        const notes = `
Description: ${taskDetails.description}

Expected Result: ${taskDetails.final_result}

User Experience: ${taskDetails.user_experience}
        `.trim();

        const taskRequestBody: tasks_v1.Schema$Task = {
            title: taskDetails.objective,
            notes: notes,
            due: dueDateTime,
        };

        // Dynamically add reminders to bypass strict TypeScript type checking for this field.
        (taskRequestBody as any).reminders = {
            useDefault: false,
            overrides: [
                { method: 'popup', minutes: 10 } // 10-minute reminder before due time
            ]
        };
        
        // Similarly, adding recurrence dynamically.
        // Note: As of the current library version, recurrence might not be officially typed.
        // (taskRequestBody as any).recurrence = [recurrenceRule];

        const response = await tasksService.tasks.insert({
            tasklist: tasklistId,
            requestBody: taskRequestBody,
        });

        return response.data;
    } catch (error: any) {
        console.error(`gtasks.ts: Error creating task for [${senderId}]:`, error.message);
        return `Sorry, I couldn't create the task in Google Tasks. Error: ${error.message}`;
    }
}

// --- PUBLIC STATUS FUNCTIONS ---

/**
 * Checks if a user is considered authenticated (i.e., has a refresh token).
 * @param senderId The user's identifier.
 * @returns True if a refresh token exists for the user, false otherwise.
 */
export function isUserAuthenticated(senderId: string): boolean {
    // Reload from file in case another process updated it. This is a simple
    // strategy for single-instance apps. For multi-instance, a shared cache (e.g., Redis) is needed.
    if (Object.keys(userTokens).length === 0 && fs.existsSync(TOKEN_FILE_PATH)) {
        userTokens = loadTokensFromFile();
    }
    return !!userTokens[senderId]?.refresh_token;
}

/**
 * Gets a user-friendly string describing the user's authentication status and token expiry.
 * @param senderId The user's identifier.
 * @returns A string with the authentication status message.
 */
export function getAuthStatus(senderId: string): string {
    if (!isUserAuthenticated(senderId)) {
        return "You are not connected to Google Tasks. Use /connect_google_tasks to link your account.";
    }
    
    const userToken = userTokens[senderId];

    if (!userToken.expiry_date) {
        return "You are connected, but your token has no expiration date information. Please reconnect.";
    }

    const expiryDate = new Date(userToken.expiry_date);
    
    if (expiryDate < new Date()) {
        return "Your connection has expired. Please use /connect_google_tasks to reconnect.";
    }
    
    const formattedDate = expiryDate.toLocaleString('en-US', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true
    });

    return `You are authenticated with Google Tasks. Your access token is valid until: ${formattedDate}`;
}

/**
 * Clears the Google tokens for a specific user and persists the change.
 * @param senderId The user's identifier.
 * @returns True if tokens were found and cleared, false otherwise.
 */
export function clearUserTokens(senderId: string): boolean {
    if (userTokens[senderId]) {
        delete userTokens[senderId];
        saveTokensToFile(userTokens);
        return true;
    }
    return false;
}
// TODO: Consider adding functions for:
// - Getting a specific task by ID
// - Updating a task (e.g., mark as complete, change title/notes)
// - Deleting a task
// - Creating a new task list
// - Deleting a task list
// - Updating a task list 