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

export { buildCatalog } from './completion/catalog';
export type {
  Catalog,
  CatalogColumn,
  CatalogDatabase,
  CatalogForeignKey,
  CatalogOptions,
  CatalogRelation,
  CatalogRelationKind,
  CatalogRoutine,
  CatalogSchema,
} from './completion/catalog';
export { complete } from './completion/complete';
export type {
  CompletionItem,
  CompletionItemKind,
  CompletionOptions,
  CompletionResult,
  SqlSnippet,
} from './completion/complete';
export { signatureHelp } from './completion/signature';
export type { SignatureHelp } from './completion/signature';
export type { FunctionSignature, SignatureParameter } from './completion/functions';
