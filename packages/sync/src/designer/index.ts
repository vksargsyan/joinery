/**
 * The table designer engine (spec §8): `designTable` turns an edited table into the save
 * script with data-loss warnings and validation, `validateTable` / `diagnoseTable` flag
 * invalid designs, `typeCatalog` / `parseType` / `formatType` drive the type dropdown, and
 * `emptyTable` / `newColumn` / `cloneTable` / `tableOptionCatalog` seed the form.
 */

export { designTable, designDropTable } from './design';
export { validateTable, diagnoseTable } from './validate';
export { typeCatalog, parseType, formatType, findType, pgQualifiedType } from './catalog';
export type {
  ParsedType,
  TypeCatalogEntry,
  TypeCategory,
  TypeParameter,
  TypeParameterName,
  UserTypeInfo,
} from './catalog';
export { emptyTable, newColumn, cloneTable, tableOptionCatalog } from './table';
export type { TableOptionInfo } from './table';
export { isReservedWord } from './names';
export type {
  DataLossSeverity,
  DataLossWarning,
  DesignContext,
  DesignOptions,
  DesignRenames,
  TableDesign,
  ValidationIssue,
} from './types';
