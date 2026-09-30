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

export {
  AGGREGATE_FUNCTIONS,
  COMPARISON_OPERATORS,
  CRITERIA_OPERATORS,
  JOIN_TYPES,
  emptyGroup,
  emptyQueryModel,
  operatorInfo,
  operatorsFor,
  referenceName,
} from './query-model/model';
export type {
  AggregateFunction,
  ColumnExpr,
  ComparisonOperator,
  Condition,
  CriteriaGroup,
  CriteriaOperator,
  Criterion,
  CustomCondition,
  GroupItem,
  JoinCondition,
  JoinType,
  OperatorArity,
  OperatorInfo,
  OrderItem,
  QueryExpr,
  QueryIssue,
  QueryJoin,
  QueryModel,
  QueryTable,
  SelectItem,
} from './query-model/model';
export { generateQuery } from './query-model/generate';
export type { GeneratedQuery } from './query-model/generate';
export { parseQuery } from './query-model/parse';
export type { QueryParseOptions, QueryParseResult } from './query-model/parse';
export { checkFragment } from './query-model/tokens';
