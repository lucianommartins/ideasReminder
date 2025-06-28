"use strict";
/**
 * @file gtasks.ts
 * @description This module handles all interactions with the Google Tasks API.
 * It manages OAuth2 authentication, token storage, token refresh, and provides
 * functions to perform CRUD operations on Google Tasks and Task Lists.
 * Tokens are persisted to a JSON file in the `src/data` directory.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.initiateGoogleAuth = initiateGoogleAuth;
exports.handleGoogleAuthCallback = handleGoogleAuthCallback;
exports.listTaskLists = listTaskLists;
exports.getTasksInList = getTasksInList;
exports.createGoogleTask = createGoogleTask;
exports.getTaskTitles = getTaskTitles;
exports.getFormattedTasksString = getFormattedTasksString;
exports.deleteGoogleTask = deleteGoogleTask;
exports.isUserAuthenticated = isUserAuthenticated;
exports.getAuthStatus = getAuthStatus;
exports.clearUserTokens = clearUserTokens;
const google_auth_library_1 = require("google-auth-library");
const googleapis_1 = require("googleapis"); // For Tasks API
const fs_1 = __importDefault(require("fs")); // Node.js File System module
const path_1 = __importDefault(require("path")); // Node.js Path module
// --- CONSTANTS ---
const DATA_DIR = path_1.default.resolve(__dirname, '..', 'data'); // Resolves to <project_root>/src/data
const TOKEN_FILE_PATH = path_1.default.join(DATA_DIR, 'google_tokens.json');
// --- Configuration (loaded from process.env in index.ts and passed or accessed here) ---
// const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
// const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
// const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;
// --- IN-MEMORY TOKEN CACHE ---
let userTokens = {};
// --- PRIVATE UTILITY FUNCTIONS ---
/**
 * Ensures that the data directory for storing tokens exists.
 * If it doesn't, it attempts to create it.
 */
function ensureDataDirectoryExists() {
    if (!fs_1.default.existsSync(DATA_DIR)) {
        console.log(`gtasks.ts: Data directory does not exist. Creating: ${DATA_DIR}`);
        try {
            fs_1.default.mkdirSync(DATA_DIR, { recursive: true });
        }
        catch (error) {
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
function loadTokensFromFile() {
    ensureDataDirectoryExists();
    if (fs_1.default.existsSync(TOKEN_FILE_PATH)) {
        try {
            const data = fs_1.default.readFileSync(TOKEN_FILE_PATH, 'utf8');
            const loadedTokens = JSON.parse(data);
            console.log(`gtasks.ts: Tokens successfully loaded. User count: ${Object.keys(loadedTokens).length}`);
            return loadedTokens;
        }
        catch (error) {
            console.error(`gtasks.ts: Failed to load or parse tokens file. Starting with empty tokens.`, error);
        }
    }
    return {};
}
/**
 * Saves the provided UserTokens object to the persistent JSON file.
 * @param tokens The complete UserTokens object to save.
 */
function saveTokensToFile(tokens) {
    ensureDataDirectoryExists();
    try {
        const data = JSON.stringify(tokens, null, 2); // Pretty-print JSON
        fs_1.default.writeFileSync(TOKEN_FILE_PATH, data, 'utf8');
    }
    catch (error) {
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
function getOAuthClient() {
    const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI } = process.env;
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) {
        console.error("gtasks.ts: Missing Google OAuth2 credentials or redirect URI in environment variables.");
        throw new Error("Google OAuth2 client configuration is incomplete. Please check server environment variables.");
    }
    return new google_auth_library_1.OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
}
// --- PUBLIC AUTHENTICATION FUNCTIONS ---
/**
 * Generates the Google OAuth2 consent URL for the user to visit to authorize the application.
 * @param senderId The user's unique identifier (e.g., WhatsApp number), used to link the auth flow back to the user.
 * @returns The fully formed authorization URL.
 */
function initiateGoogleAuth(senderId) {
    const oauth2Client = getOAuthClient();
    const scopes = [
        'openid', // Required to signal an OpenID Connect flow
        'https://www.googleapis.com/auth/userinfo.profile', // For name, locale, etc.
        'https://www.googleapis.com/auth/tasks'
    ];
    const url = oauth2Client.generateAuthUrl({
        access_type: 'offline', // Crucial for obtaining a refresh_token for long-term access.
        scope: scopes,
        state: senderId, // Pass senderId through the flow to identify the user in the callback.
        prompt: 'consent', // Ensures the user is prompted for consent, which helps in issuing a refresh_token.
    });
    return url;
}
/**
 * Handles the OAuth2 callback from Google. It exchanges the authorization code for tokens.
 * @param code The authorization code received from Google in the callback query parameters.
 * @param senderId The user's identifier, retrieved from the 'state' query parameter.
 * @throws An error if the token exchange fails or if essential tokens are not received.
 */
async function handleGoogleAuthCallback(code, senderId) {
    const oauth2Client = getOAuthClient();
    try {
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens); // Set credentials for the next call
        if (!tokens.refresh_token) {
            console.warn(`gtasks.ts: No refresh_token received for [${senderId}]. This can happen if the user has already granted consent and the 'prompt' parameter was not 'consent'. The user may need to re-authenticate if offline access expires.`);
        }
        if (!tokens.access_token || !tokens.expiry_date) {
            throw new Error('Incomplete token data received from Google during auth code exchange.');
        }
        // --- Fetch User's Locale ---
        let userLocale = undefined;
        try {
            // Use the authenticated client to get user info
            const oauth2 = googleapis_1.google.oauth2({ version: 'v2', auth: oauth2Client });
            const userInfoResponse = await oauth2.userinfo.get();
            // Ensure we store undefined instead of null if locale is not present
            userLocale = userInfoResponse.data.locale || undefined;
            console.log(`gtasks.ts: Fetched locale for [${senderId}]: ${userLocale}`);
        }
        catch (infoError) {
            console.warn(`gtasks.ts: Could not fetch user profile info for [${senderId}] despite successful auth. Locale will not be stored.`, infoError);
        }
        userTokens[senderId] = {
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token || undefined,
            scope: tokens.scope,
            token_type: 'Bearer',
            expiry_date: tokens.expiry_date,
            locale: userLocale,
        };
        saveTokensToFile(userTokens);
    }
    catch (error) {
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
async function getAuthenticatedClient(senderId) {
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
                access_token: credentials.access_token,
                scope: credentials.scope || user.scope,
                expiry_date: credentials.expiry_date,
            };
            oauth2Client.setCredentials(userTokens[senderId]);
            saveTokensToFile(userTokens);
        }
        catch (refreshError) {
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
async function listTaskLists(senderId) {
    try {
        const oauth2Client = await getAuthenticatedClient(senderId);
        const tasksService = googleapis_1.google.tasks({ version: 'v1', auth: oauth2Client });
        const response = await tasksService.tasklists.list({ maxResults: 25 });
        return response.data.items || [];
    }
    catch (error) {
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
async function getTasksInList(senderId, tasklistId = '@default') {
    try {
        const oauth2Client = await getAuthenticatedClient(senderId);
        const tasksService = googleapis_1.google.tasks({ version: 'v1', auth: oauth2Client });
        const response = await tasksService.tasks.list({
            tasklist: tasklistId,
            showCompleted: false,
            showHidden: false,
            maxResults: 50,
        });
        return response.data.items || [];
    }
    catch (error) {
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
async function createGoogleTask(senderId, taskDetails, tasklistId = '@default') {
    try {
        const oauth2Client = await getAuthenticatedClient(senderId);
        const tasksService = googleapis_1.google.tasks({ version: 'v1', auth: oauth2Client });
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
        const pad = (num) => (num < 10 ? '0' : '') + num;
        const dueDateTime = `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}T${pad(tomorrow.getHours())}:${pad(tomorrow.getMinutes())}:${pad(tomorrow.getSeconds())}.000${offset >= 0 ? '+' : '-'}${pad(Math.abs(offset))}:00`;
        const recurrenceRule = 'RRULE:FREQ=DAILY;COUNT=3'; // Repeat daily for 3 days.
        // --- Construct Task Body ---
        // Combine the structured details into a comprehensive task description.
        const notes = `
Description: ${taskDetails.description}

Expected Result: ${taskDetails.final_result}

User Experience: ${taskDetails.user_experience}
        `.trim();
        const taskRequestBody = {
            title: taskDetails.objective,
            notes: notes,
            due: dueDateTime,
        };
        // Dynamically add reminders to bypass strict TypeScript type checking for this field.
        taskRequestBody.reminders = {
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
    }
    catch (error) {
        console.error(`gtasks.ts: Error creating task for [${senderId}]:`, error.message);
        return `Sorry, I couldn't create the task in Google Tasks. Error: ${error.message}`;
    }
}
/**
 * Fetches only the titles of all active tasks for a user.
 * @param senderId The user's identifier.
 * @returns A promise that resolves to an array of task titles, or null if no tasks are found.
 */
async function getTaskTitles(senderId) {
    try {
        const oauth2Client = await getAuthenticatedClient(senderId);
        const tasksService = googleapis_1.google.tasks({ version: 'v1', auth: oauth2Client });
        const taskListsResponse = await tasksService.tasklists.list({ maxResults: 100 });
        const taskLists = taskListsResponse.data.items;
        if (!taskLists || taskLists.length === 0) {
            return null; // No lists, so no tasks
        }
        const titles = [];
        for (const taskList of taskLists) {
            const tasksResponse = await tasksService.tasks.list({
                tasklist: taskList.id,
                showCompleted: false,
                showHidden: false,
                maxResults: 100,
            });
            const tasks = tasksResponse.data.items;
            if (tasks) {
                for (const task of tasks) {
                    if (task.title) {
                        titles.push(task.title);
                    }
                }
            }
        }
        return titles.length > 0 ? titles : null;
    }
    catch (error) {
        console.error(`gtasks.ts: Error fetching task titles for [${senderId}]:`, error.message);
        // In case of an error, we can't get titles, so we return null.
        // The calling function should handle informing the user about the error.
        return null;
    }
}
/**
 * Fetches all task lists and all tasks within them, then formats them into a single,
 * human-readable string for display in a chat.
 * @param senderId The user's identifier.
 * @returns A promise that resolves to a formatted string of all tasks or an error message.
 */
async function getFormattedTasksString(senderId) {
    try {
        const oauth2Client = await getAuthenticatedClient(senderId);
        const tasksService = googleapis_1.google.tasks({ version: 'v1', auth: oauth2Client });
        const taskListsResponse = await tasksService.tasklists.list({ maxResults: 25 });
        const taskLists = taskListsResponse.data.items;
        if (!taskLists || taskLists.length === 0) {
            return "You don't have any task lists in your Google Tasks.";
        }
        let formattedString = "📋 *Here are your tasks from Google Tasks:*\n";
        let totalTaskCount = 0;
        for (const taskList of taskLists) {
            formattedString += `\n\n--- *List: ${taskList.title}* ---\n`;
            const tasksResponse = await tasksService.tasks.list({
                tasklist: taskList.id,
                showCompleted: false,
                showHidden: false,
                maxResults: 100,
            });
            const tasks = tasksResponse.data.items;
            if (!tasks || tasks.length === 0) {
                formattedString += "_(This list is empty)_\n";
            }
            else {
                totalTaskCount += tasks.length;
                for (const task of tasks) {
                    formattedString += `\n*• ${task.title || 'Untitled Task'}*\n`;
                    if (task.notes) {
                        // Indent notes for better readability
                        const indentedNotes = task.notes.split('\n').map(line => `  - ${line}`).join('\n');
                        formattedString += `  *Notes:*\n${indentedNotes}\n`;
                    }
                    if (task.due) {
                        try {
                            const dueDate = new Date(task.due);
                            // Using a common, user-friendly format, but now with the user's own locale
                            const formattedDueDate = dueDate.toLocaleDateString(userTokens[senderId]?.locale || 'en-US', {
                                weekday: 'long',
                                year: 'numeric',
                                month: 'long',
                                day: 'numeric',
                                hour: '2-digit',
                                minute: '2-digit'
                            });
                            formattedString += `  *Due:* ${formattedDueDate}\n`;
                        }
                        catch (e) { /* Ignore invalid date formats */ }
                    }
                }
            }
        }
        if (totalTaskCount === 0) {
            return "It looks like you have task lists set up, but they are all empty. You can create a task by sending me a message like 'remind me to buy milk'.";
        }
        return formattedString;
    }
    catch (error) {
        console.error(`gtasks.ts: Error formatting task string for [${senderId}]:`, error.message);
        // The error message from getAuthenticatedClient is user-friendly enough
        return `I couldn't fetch your tasks. There might be an issue with your connection. Error: ${error.message}`;
    }
}
/**
 * Finds and deletes a single Google Task based on an exact title match.
 * To prevent accidental deletion, this function will fail if multiple tasks share the same title.
 * @param senderId The user's identifier.
 * @param taskTitle The exact title of the task to delete.
 * @returns A promise that resolves to a user-friendly success or failure message.
 */
async function deleteGoogleTask(senderId, taskTitle) {
    try {
        const oauth2Client = await getAuthenticatedClient(senderId);
        const tasksService = googleapis_1.google.tasks({ version: 'v1', auth: oauth2Client });
        const taskListsResponse = await tasksService.tasklists.list({ maxResults: 100 });
        const taskLists = taskListsResponse.data.items;
        if (!taskLists || taskLists.length === 0) {
            return "You have no task lists to delete from.";
        }
        const foundTasks = [];
        const normalizedTargetTitle = taskTitle.trim().toLowerCase();
        // Search through all tasks in all lists
        for (const taskList of taskLists) {
            const tasksResponse = await tasksService.tasks.list({
                tasklist: taskList.id,
                showCompleted: false,
                showHidden: false,
                maxResults: 100,
            });
            const tasks = tasksResponse.data.items;
            if (tasks) {
                for (const task of tasks) {
                    if (task.title?.trim().toLowerCase() === normalizedTargetTitle) {
                        foundTasks.push({ tasklistId: taskList.id, taskId: task.id });
                    }
                }
            }
        }
        // --- Handle different scenarios based on search results ---
        if (foundTasks.length === 0) {
            return `I couldn't find a task with the exact title "${taskTitle}". Please check the name and try again. You can list your tasks to see the correct titles.`;
        }
        if (foundTasks.length > 1) {
            return `I found ${foundTasks.length} tasks with the title "${taskTitle}". To avoid deleting the wrong one, please specify which task you mean or rename them to be unique.`;
        }
        // --- Proceed with deletion ---
        const taskToDelete = foundTasks[0];
        await tasksService.tasks.delete({
            tasklist: taskToDelete.tasklistId,
            task: taskToDelete.taskId,
        });
        return `✅ Successfully deleted the task: "${taskTitle}"`;
    }
    catch (error) {
        console.error(`gtasks.ts: Error deleting task "${taskTitle}" for [${senderId}]:`, error.message);
        return `I encountered an error trying to delete the task. Error: ${error.message}`;
    }
}
// --- PUBLIC STATUS FUNCTIONS ---
/**
 * Checks if a user is considered authenticated (i.e., has a refresh token).
 * @param senderId The user's identifier.
 * @returns True if a refresh token exists for the user, false otherwise.
 */
function isUserAuthenticated(senderId) {
    // Reload from file in case another process updated it. This is a simple
    // strategy for single-instance apps. For multi-instance, a shared cache (e.g., Redis) is needed.
    if (Object.keys(userTokens).length === 0 && fs_1.default.existsSync(TOKEN_FILE_PATH)) {
        userTokens = loadTokensFromFile();
    }
    return !!userTokens[senderId]?.refresh_token;
}
/**
 * Gets a user-friendly string describing the user's authentication status and token expiry.
 * @param senderId The user's unique identifier.
 * @returns A status message indicating whether the user is connected and the token's expiry.
 */
async function getAuthStatus(senderId) {
    const user = userTokens[senderId];
    if (!user) {
        return 'You are not connected to Google Tasks. Please use the command /connect_google_tasks to link your account.';
    }
    try {
        // We call getAuthenticatedClient as it contains the logic to refresh the token if it's expired.
        // If this call succeeds, the user is considered connected and their token is fresh.
        await getAuthenticatedClient(senderId);
        // After a successful check (and potential refresh), re-read the user's token data.
        const updatedUser = userTokens[senderId];
        if (!updatedUser || !updatedUser.expiry_date) {
            // This case should theoretically not be reached if getAuthenticatedClient succeeds.
            return 'Connection status is uncertain. Please try to reconnect using /disconnect_google_tasks and then /connect_google_tasks.';
        }
        const expiryDate = new Date(updatedUser.expiry_date);
        const userLocale = updatedUser.locale || 'en-US'; // Fallback to a default
        const formattedDate = expiryDate.toLocaleString(userLocale, {
            dateStyle: 'full',
            timeStyle: 'long',
        });
        return `✅ You are connected to Google Tasks.\nYour current connection is valid until:\n*${formattedDate}*`;
    }
    catch (error) {
        // If getAuthenticatedClient throws an error, it means the refresh token failed.
        // The error message from that function is user-friendly.
        return `❌ Your connection to Google Tasks has expired or was revoked, and it could not be refreshed automatically. Please reconnect using the command: /connect_google_tasks\n\n(Error: ${error.message})`;
    }
}
/**
 * Clears the Google tokens for a specific user and persists the change.
 * @param senderId The user's identifier.
 * @returns True if tokens were found and cleared, false otherwise.
 */
function clearUserTokens(senderId) {
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
