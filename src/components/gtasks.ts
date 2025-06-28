/**
 * @file gtasks.ts
 * @description This module handles all interactions with the Google Tasks API.
 * It relies on the gauth.ts component to obtain a pre-authenticated client.
 */

import { google, tasks_v1 } from 'googleapis';
import { getAuthenticatedClient } from './gauth'; // Import the key function
import { IdentifiedTask } from '../types/chat';

// --- PUBLIC API FUNCTIONS (for Google Tasks) ---

/**
 * Lists the authenticated user's task lists.
 * @param senderId The user's identifier.
 * @returns A promise that resolves to an array of task lists or an error message string.
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
 * @returns A promise that resolves to an array of tasks or an error message string.
 */
export async function getTasksInList(senderId: string, tasklistId: string = '@default'): Promise<tasks_v1.Schema$Task[] | string> {
    try {
        const oauth2Client = await getAuthenticatedClient(senderId);
        const tasksService = google.tasks({ version: 'v1', auth: oauth2Client });
        const response = await tasksService.tasks.list({
            tasklist: tasklistId,
            showCompleted: false,
            maxResults: 100,
        });
        return response.data.items || [];
    } catch (error: any) {
        console.error(`gtasks.ts: Error getting tasks for [${senderId}]:`, error.message);
        return `Error fetching tasks: ${error.message}`;
    }
}

/**
 * Creates a new task in the user's Google Tasks.
 * @param senderId The user's identifier.
 * @param taskDetails The details of the task to be created.
 * @param tasklistId The ID of the task list (defaults to '@default').
 * @returns A promise that resolves to the created task object or an error message string.
 */
export async function createGoogleTask(
    senderId: string,
    taskDetails: { title: string; description?: string; dueDate?: string },
    tasklistId: string = '@default'
): Promise<tasks_v1.Schema$Task | string> {
    try {
        const oauth2Client = await getAuthenticatedClient(senderId);
        const tasksService = google.tasks({ version: 'v1', auth: oauth2Client });

        const task: tasks_v1.Schema$Task = {
            title: taskDetails.title,
            notes: taskDetails.description || undefined,
        };

        if (taskDetails.dueDate) {
            const date = new Date(taskDetails.dueDate);
            const pad = (num: number) => (num < 10 ? '0' : '') + num;
            task.due = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T00:00:00.000Z`;
        }

        const response = await tasksService.tasks.insert({
            tasklist: tasklistId,
            requestBody: task,
        });
        
        return response.data;
    } catch (error: any) {
        console.error(`gtasks.ts: Error creating task for [${senderId}]:`, error.message);
        return `Error creating Google Task: ${error.message}`;
    }
}

/**
 * Retrieves just the titles of all tasks in the default list for quick display.
 * @param senderId The user's identifier.
 * @returns A promise that resolves to an array of task titles or null if an error occurs.
 */
export async function getTaskTitles(senderId: string): Promise<string[] | null> {
    const tasks = await getTasksInList(senderId);
    if (Array.isArray(tasks)) {
        return tasks.map(task => task.title || 'Untitled Task');
    }
    return null;
}

/**
 * Fetches all tasks and formats them into a single, user-friendly numbered string.
 * @param senderId The user's identifier.
 * @returns A formatted string of tasks or an error message.
 */
export async function getFormattedTasksString(senderId: string): Promise<string> {
    const tasks = await getTasksInList(senderId);

    if (typeof tasks === 'string') {
        return tasks; // Return the error message directly
    }
    
    if (!tasks || tasks.length === 0) {
        return "You have no tasks in your default list.";
    }

    return tasks
        .map((task, index) => `${index + 1}. ${task.title || 'Untitled Task'}`)
        .join('\n');
}


/**
 * Deletes a Google Task based on its title.
 * @param senderId The user's identifier.
 * @param taskTitle The title of the task to delete.
 * @returns A success or error message string.
 */
export async function deleteGoogleTask(senderId: string, taskTitle: string): Promise<string> {
    try {
        const oauth2Client = await getAuthenticatedClient(senderId);
        const tasksService = google.tasks({ version: 'v1', auth: oauth2Client });
        
        const tasksResult = await getTasksInList(senderId);
        if (typeof tasksResult === 'string') {
            return `Could not fetch tasks to find the one to delete: ${tasksResult}`;
        }

        const taskToDelete = tasksResult.find(t => t.title?.trim().toLowerCase() === taskTitle.trim().toLowerCase());

        if (!taskToDelete || !taskToDelete.id) {
            return `Task "${taskTitle}" not found.`;
        }

        await tasksService.tasks.delete({
            tasklist: '@default',
            task: taskToDelete.id,
        });

        return `Task "${taskTitle}" deleted successfully.`;
    } catch (error: any) {
        console.error(`gtasks.ts: Error deleting task for [${senderId}]:`, error.message);
        return `Error deleting task: ${error.message}`;
    }
} 