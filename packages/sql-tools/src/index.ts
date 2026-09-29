export { quoteIdent, quoteQualified, quoteString } from './dialect';

export { isTrivia, significantTokens, tokenize } from './lexer';
export type { Token, TokenKind, TokenizeOptions } from './lexer';

export { StatementSplitter, splitStatements, statementAt } from './splitter';
export type { SqlStatement } from './splitter';

export { bindParameters, findParameters, parameterNames } from './parameters';
export type { BoundQuery, ParameterOptions, ParameterStyle, SqlParameter } from './parameters';

export {
  ALWAYS_CONFIRM,
  analyzeStatement,
  checkStatementSafety,
  decideSafety,
  safetyPolicyFor,
} from './safety';
export type {
  ConfirmationReason,
  SafetyDecision,
  SafetyPolicy,
  StatementAnalysis,
  StatementKind,
  StatementRisk,
} from './safety';

export { formatSql } from './format';
export type { SqlFormatOptions } from './format';

export { MAX_DIAGNOSED_STATEMENT_LENGTH, diagnose } from './diagnostics';
export type { SqlDiagnostic } from './diagnostics';
