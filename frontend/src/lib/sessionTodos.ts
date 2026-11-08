import { z } from "zod";
import type {
  SessionMessageAssistant,
  SessionMessageInfo,
} from "@opencode-manager/shared/opencode";

type AssistantContentPart = SessionMessageAssistant["content"][number];

const SessionTodoSchema = z.object({
  content: z.string(),
  status: z.enum(["pending", "in_progress", "completed", "cancelled"]),
});

export type SessionTodo = z.infer<typeof SessionTodoSchema>;

export interface TodoProgress {
  completed: number;
  total: number;
  percent: number;
}

/** Todos written by one completed `todowrite` call, or null for any other part or a malformed input. */
export function todosFromPart(
  part: AssistantContentPart,
): SessionTodo[] | null {
  if (
    part.type !== "tool" ||
    part.name !== "todowrite" ||
    part.state.status !== "completed"
  )
    return null;
  const parsed = z.array(SessionTodoSchema).safeParse(part.state.input.todos);
  return parsed.success ? parsed.data : null;
}

/**
 * The session's current todo list. OpenCode 2 keeps no separate todo state: like its own interface,
 * the list is the input of the latest completed `todowrite` call in the loaded transcript.
 */
export function latestSessionTodos(
  messages: readonly SessionMessageInfo[],
): SessionTodo[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.type !== "assistant") continue;
    for (
      let partIndex = message.content.length - 1;
      partIndex >= 0;
      partIndex -= 1
    ) {
      const part = message.content[partIndex];
      const todos = part ? todosFromPart(part) : null;
      if (todos) return todos;
    }
  }
  return [];
}

/** Completed out of non-cancelled todos, or null when nothing countable remains. */
export function getTodoProgress(
  todos: readonly SessionTodo[],
): TodoProgress | null {
  const total = todos.filter((todo) => todo.status !== "cancelled").length;
  if (total === 0) return null;
  const completed = todos.filter((todo) => todo.status === "completed").length;
  return { completed, total, percent: Math.round((completed / total) * 100) };
}
