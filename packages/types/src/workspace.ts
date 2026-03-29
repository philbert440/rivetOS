/**
 * Workspace interface — file-based configuration injected into system prompt.
 */

export interface WorkspaceFile {
  name: string;
  path: string;
  content: string;
}

export interface Workspace {
  load(): Promise<WorkspaceFile[]>;
  read(filename: string): Promise<string | null>;
  write(filename: string, content: string): Promise<void>;
}
