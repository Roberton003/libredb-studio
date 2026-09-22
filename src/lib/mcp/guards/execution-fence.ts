import { inspectAgentStatement, type AgentStatementViolation } from "@/lib/db/operations/statement-guard";

class McpSecurityViolationError extends Error {
  public readonly code: AgentStatementViolation;

  constructor(code: AgentStatementViolation, details?: string) {
    super(`MCP execution fence rejected statement: ${code}${details ? ` (${details})` : ""}`);
    this.name = "McpSecurityViolationError";
    this.code = code;
  }
}

/**
 * Valida se uma instrução SQL é estritamente segura para execução em modo leitura via MCP.
 * Reutiliza a cerca nativa do LibreDB Studio (`inspectAgentStatement`), bloqueando DDL, DML,
 * multi-statements, transações manuais e palavras-chave de efeito colateral.
 *
 * @param sql Instrução SQL a ser inspecionada
 * @throws McpSecurityViolationError se houver qualquer violação
 */
export function assertReadOnlyStatement(sql: string): void {
  const violation = inspectAgentStatement(sql, { allowPlanExecution: false });
  if (violation !== null) {
    throw new McpSecurityViolationError(violation);
  }
}

/**
 * Versão não-excepcional da cerca de execução.
 * Retorna null se seguro, ou o código da violação caso rejeitado.
 */
export function checkReadOnlyStatement(sql: string): AgentStatementViolation | null {
  return inspectAgentStatement(sql, { allowPlanExecution: false });
}
