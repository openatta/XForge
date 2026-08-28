
export interface Metadata {
  name: string;
  version?: string | number;
  description?: string;
}

/**
 * The seven extension kinds a project can author.
 *
 * They share a shape -- `apiVersion`, `kind`, `metadata`, `spec` -- because they are all loaded,
 * locked and projected by the same machinery, and a new kind that does not share it would have to
 * teach every one of those layers about itself.
 */

export interface AgentResource {
  apiVersion: string;
  kind: 'Agent';
  metadata: Metadata;
  spec: {
    role: string;
    instructions: string;
    skills: string[];
    tools: { allow: string[] };
    delegation: { callableBy: string[]; maxConcurrency: number };
    model: { class: string; fallback: string };
  };
}

export interface RuleResource {
  apiVersion: string;
  kind: 'Rule';
  metadata: Metadata;
  spec: {
    level?: 'mandatory' | 'advisory' | 'scoped';
    severity?: 'must' | 'should';
    instruction: string;
    modules?: string[];
    paths?: string[];
    gate?: string;
    writePolicy?: 'integrator-only';
    constitutionCompatibility?: 'compatible' | 'conflict';
    scope?: {
      modules?: string[];
      paths?: string[];
      stages?: string[];
    };
    enforcement?: {
      gateRefs: string[];
      policyRefs: string[];
      approvalRefs?: string[];
    };
  };
}

export interface PermissionPolicyResource {
  apiVersion: 'xforge.dev/v1alpha2';
  kind: 'PermissionPolicy';
  metadata: Metadata;
  spec: {
    capability: 'fs.read' | 'fs.write' | 'shell' | 'network' | 'mcp' | 'subagent' | 'external.write';
    effect: 'deny' | 'ask' | 'allow';
    match: {
      paths?: string[];
      commands?: string[];
      tools?: string[];
      hosts?: string[];
      mcpServers?: string[];
      stages?: string[];
    };
    exceptActors?: string[];
    reason: string;
  };
}

export interface HookResource {
  apiVersion: string;
  kind: 'Hook';
  metadata: Metadata;
  spec: {
    enabled: boolean;
    plane?: 'runtime' | 'workflow';
    event: string;
    action?: { scriptRef?: string; builtin?: 'audit' | 'policy' };
    command?: string[];
    shell?: boolean;
    timeoutSeconds: number;
    workingDirectory?: string;
    permissions?: Array<'read' | 'write' | 'network'>;
    failurePolicy: 'deny' | 'ask' | 'stop' | 'spool' | 'warn';
    network?: boolean;
    matcher?: string;
  };
}

export interface GateResource {
  apiVersion: string;
  kind: 'Gate';
  metadata: Metadata;
  spec: {
    required: boolean;
    /* Kept in step with gate.schema.json's enum, which has always accepted `declared`; the type
       omitted it, so every `builtin === 'declared'` test outside the runner failed to compile. */
    builtin?: 'structure' | 'check-findings' | 'constitution-check' | 'declared';
    command?: string[];
    shell?: boolean;
    workingDirectory?: string;
    timeoutSeconds: number;
    maxOutputBytes?: number;
    evidence: string;
    /**
     * Extra environment variable names this Gate's subprocess may inherit, on top of the built-in
     * allowlist and `Manifest.gates.env`. Names that look like credentials are always dropped.
     */
    env?: { allow?: string[]; allowPrefixes?: string[] };
  };
}

export interface ScriptResource {
  apiVersion: string;
  kind: 'Script';
  metadata: Metadata;
  spec: {
    runtime: 'node' | 'python';
    entry: string;
    arguments: string[];
    workingDirectory: string;
    timeoutSeconds: number;
    input: string;
    output: string;
    sideEffects: string;
  };
}

export interface McpServerResource {
  apiVersion: string;
  kind: 'McpServer';
  metadata: Metadata;
  spec: {
    transport: 'stdio' | 'http';
    command?: string[];
    cwd?: string;
    url?: string;
    authTokenEnv: string;
    timeoutSeconds: number;
    /**
     * Extra environment variable names (`allow`) and name prefixes (`allowPrefixes`, e.g.
     * `CORP_APPROVALS_`) this MCP provider's `stdio` subprocess may inherit, on top of the built-in
     * allowlist (see core/env-safety.ts). Names that look like credentials are always dropped, even
     * if listed here or matched by a declared prefix.
     */
    env?: { allow?: string[]; allowPrefixes?: string[] };
  };
}
