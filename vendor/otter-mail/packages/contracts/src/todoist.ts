import { z } from "zod";

export const todoistTaskInput = z.object({
  content: z.string().trim().min(1).max(500),
  description: z.string().max(12000).default(""),
  projectId: z.string().min(1).max(200).optional(),
  sectionId: z.string().min(1).max(200).optional(),
  assigneeId: z.string().max(200).nullable().optional(),
  labels: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
  due: z.string().trim().max(200).optional(),
  priority: z.number().int().min(1).max(4).default(1),
  requestId: z.uuid(),
  email: z.object({ accountId: z.string().min(1), messageId: z.string().min(1) }).optional(),
});
export const todoistTaskUpdate = todoistTaskInput
  .omit({ email: true })
  .partial()
  .extend({
    id: z.string().min(1).max(200),
    description: z.string().max(12000).optional(),
    priority: z.number().int().min(1).max(4).optional(),
    requestId: z.uuid(),
    moveRequestId: z.uuid(),
    sectionId: z.string().min(1).max(200).nullable().optional(),
  });
export const todoistReminderInput = z.object({
  itemId: z.string().min(1).max(200),
  due: z.string().trim().min(1).max(200),
  requestId: z.uuid(),
});
export type TodoistTaskUpdate = z.input<typeof todoistTaskUpdate>;
export type TodoistReminderInput = z.input<typeof todoistReminderInput>;
export type TodoistSection = { id: string; name: string; project_id: string };
export type TodoistCollaborator = { id: string; name: string; email: string };
export type TodoistReminder = {
  id: string;
  type: string;
  minute_offset: number;
  due: { date: string; string: string } | null;
};
export type TodoistTaskInput = z.input<typeof todoistTaskInput>;
export type TodoistProject = { id: string; name: string };
export type TodoistTask = {
  id: string;
  content: string;
  description: string;
  project_id: string;
  priority: number;
  section_id?: string | null;
  responsible_uid?: string | null;
  labels?: string[];
  due: { date: string; string: string; is_recurring: boolean } | null;
};
export type TodoistPage = { results: TodoistTask[]; next_cursor: string | null };
