/**
 * @file gtasks.ts
 * @description This module handles all interactions with the Google Tasks API.
 * It relies on the gauth.ts component to obtain a pre-authenticated client.
 */

import { google, tasks_v1 } from 'googleapis';
import { getAuthenticatedClient } from './gauth'; // Import the key function

const DEDICATED_TASK_LIST_NAME = 'GDM DevRel list';

/**
 * Finds the ID of the dedicated task list for the application.
 * @param tasksService An authenticated Google Tasks service instance.
 * @returns The ID of the task list, or null if not found.
 */
async function findDedicatedTaskListId(tasksService: tasks_v1.Tasks): Promise<string | null> {
    const response = await tasksService.tasklists.list({ maxResults: 100 });
    const taskLists = response.data.items || [];
    const dedicatedList = taskLists.find(list => list.title === DEDICATED_TASK_LIST_NAME);
    return dedicatedList?.id || null;
}

/**
 * Gets the ID of the dedicated task list, creating it if it doesn't exist.
 * @param tasksService An authenticated Google Tasks service instance.
 * @returns The ID of the dedicated task list.
 * @throws An error if the list cannot be found or created.
 */
async function ensureDedicatedTaskListExists(tasksService: tasks_v1.Tasks): Promise<string> {
    const taskListId = await findDedicatedTaskListId(tasksService);
    if (taskListId) {
        return taskListId;
    }

    console.log(`gtasks.ts: Dedicated task list "${DEDICATED_TASK_LIST_NAME}" not found. Creating it.`);
    const newList = await tasksService.tasklists.insert({
        requestBody: { title: DEDICATED_TASK_LIST_NAME },
    });

    const newId = newList.data.id;
    if (!newId) {
        throw new Error("Failed to create the dedicated task list, received no ID.");
    }

    console.log(`gtasks.ts: Created new dedicated task list with ID [${newId}].`);
    return newId;
}

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
 * Lists tasks within the dedicated task list for the authenticated user.
 * @param senderId The user's identifier.
 * @returns A promise that resolves to an array of tasks or an error message string.
 */
export async function getTasksInList(senderId: string): Promise<tasks_v1.Schema$Task[] | string> {
    try {
        const oauth2Client = await getAuthenticatedClient(senderId);
        const tasksService = google.tasks({ version: 'v1', auth: oauth2Client });
        
        const tasklistId = await findDedicatedTaskListId(tasksService);
        if (!tasklistId) {
            return []; // If the list doesn't exist, there are no tasks.
        }

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
 * Creates a new task in the user's dedicated Google Tasks list.
 * @param senderId The user's identifier.
 * @param taskDetails The details of the task to be created.
 * @returns A promise that resolves to the created task object or an error message string.
 */
export async function createGoogleTask(
    senderId: string,
    taskDetails: { title: string; description?: string; dueDate?: string },
): Promise<tasks_v1.Schema$Task | string> {
    try {
        const oauth2Client = await getAuthenticatedClient(senderId);
        const tasksService = google.tasks({ version: 'v1', auth: oauth2Client });
        const tasklistId = await ensureDedicatedTaskListExists(tasksService);

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
 * Retrieves just the titles of all tasks in the dedicated list for quick display.
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
        return `You have no tasks in your "${DEDICATED_TASK_LIST_NAME}" list.`;
    }

    let hasDueDate = false;

    const tasksString = tasks
        .map((task, index) => {
            const title = `*${index + 1}. ${task.title || 'Untitled Task'}*`;
            
            let notes = '';
            if (task.notes) {
                notes = `\n  ${task.notes.replace(/\n\n/g, '\n  ')}`;
            }
            
            let dueDate = '';
            if (task.due) {
                hasDueDate = true;
                const formattedDate = task.due.substring(0, 10);
                dueDate = `\n  - Reminder: ${formattedDate}`;
            }

            return `${title}${notes}${dueDate}`;
        })
        .join('\n\n');

    const footer = hasDueDate ? '\n\n(Reminder dates are in YYYY-MM-DD format)' : '';
    
    return `*Tasks in "${DEDICATED_TASK_LIST_NAME}":*\n\n${tasksString}${footer}`;
}

/**
 * Deletes a Google Task based on its title from the dedicated list.
 * If it's the last task, the list is also deleted.
 * @param senderId The user's identifier.
 * @param taskTitle The title of the task to delete.
 * @returns A success or error message string.
 */
export async function deleteGoogleTask(senderId: string, taskTitle: string): Promise<string> {
    try {
        const oauth2Client = await getAuthenticatedClient(senderId);
        const tasksService = google.tasks({ version: 'v1', auth: oauth2Client });
        
        const tasklistId = await findDedicatedTaskListId(tasksService);
        if (!tasklistId) {
            return `Task "${taskTitle}" not found, as the dedicated task list doesn't exist.`;
        }

        const tasksResult = await tasksService.tasks.list({
            tasklist: tasklistId,
            showCompleted: false,
            maxResults: 100
        }).then(res => res.data.items || []);

        const taskToDelete = tasksResult.find(t => t.title?.trim().toLowerCase() === taskTitle.trim().toLowerCase());

        if (!taskToDelete?.id) {
            return `Task "${taskTitle}" not found in the "${DEDICATED_TASK_LIST_NAME}" list.`;
        }

        await tasksService.tasks.delete({
            tasklist: tasklistId,
            task: taskToDelete.id,
        });
        console.log(`gtasks.ts: Deleted task [${taskToDelete.id}] titled "${taskTitle}" for user [${senderId}].`);

        if (tasksResult.length === 1) {
            console.log(`gtasks.ts: That was the last task. Deleting dedicated task list [${tasklistId}].`);
            await tasksService.tasklists.delete({
                tasklist: tasklistId,
            });
            return `Task "${taskTitle}" deleted successfully. As it was the last one, the "${DEDICATED_TASK_LIST_NAME}" list was also removed.`;
        }

        return `Task "${taskTitle}" deleted successfully.`;
    } catch (error: any) {
        console.error(`gtasks.ts: Error deleting task for [${senderId}]:`, error.message);
        return `Error deleting task: ${error.message}`;
    }
} 