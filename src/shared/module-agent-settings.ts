export type ModuleAgentSettingsId = 'requirements' | 'codes' | 'logs' | 'assistant';

export interface AgentSettingsSkill {
  key: string;
  name: string;
  description: string;
  selected: boolean;
  content: string;
  editable: boolean;
}

export interface AgentSettingsImport {
  files: Array<{ path: string; content: string }>;
}

export interface AgentSettingsView {
  id: ModuleAgentSettingsId;
  enabled: boolean;
  implemented: boolean;
  revision: string;
  prompt: string;
  model: { provider: string; id: string } | null;
  workspace: string | null;
  workspacePath: string;
  workspaceDefaultPath: string;
  skills: AgentSettingsSkill[];
}

export interface AgentSettingsUpdate {
  revision: string;
  prompt: string;
  model: { provider: string; id: string } | null;
  workspace?: string | null;
  skills: Array<{ key: string; selected: boolean; content?: string }>;
  imports?: AgentSettingsImport[];
}
