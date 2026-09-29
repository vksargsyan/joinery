import {
  MongoBulkWriteError,
  MongoMissingDependencyError,
  MongoNetworkError,
  MongoParseError,
  MongoServerError,
  MongoServerSelectionError,
} from 'mongodb';
import { describe, expect, it } from 'vitest';

import { describeValidationFailure, mapMongoError } from '../src';

const context = { where: 'db.example.com:27017', secrets: ['hunter2'] };

function serverError(
  code: number,
  message: string,
  extra: Record<string, unknown> = {},
): MongoServerError {
  return new MongoServerError({ ok: 0, errmsg: message, code, ...extra });
}

/** A server selection failure over a fake topology description. */
function selectionError(
  type: string,
  servers: Record<string, unknown>[],
): MongoServerSelectionError {
  const reason = {
    type,
    servers: new Map(servers.map((s) => [String(s['address']), s])),
  };
  return new MongoServerSelectionError(
    'Server selection timed out after 10000 ms',
    reason as never,
  );
}

/** Recorded from MongoDB 8.0: a $jsonSchema validator with several failed rules. */
const JSON_SCHEMA_FAILURE = {
  failingDocumentId: 'x',
  details: {
    operatorName: '$jsonSchema',
    schemaRulesNotSatisfied: [
      {
        operatorName: 'properties',
        propertiesNotSatisfied: [
          {
            propertyName: 'name',
            details: [
              {
                operatorName: 'minLength',
                specifiedAs: { minLength: 2 },
                reason: 'specified string length was not satisfied',
                consideredValue: 'x',
              },
            ],
          },
          {
            propertyName: 'age',
            details: [
              {
                operatorName: 'bsonType',
                specifiedAs: { bsonType: 'int' },
                reason: 'type did not match',
                consideredValue: 'old',
                consideredType: 'string',
              },
            ],
          },
          {
            propertyName: 'tags',
            details: [
              {
                operatorName: 'items',
                reason: 'At least one item did not match the sub-schema',
                itemIndex: 1,
                details: [
                  {
                    operatorName: 'bsonType',
                    specifiedAs: { bsonType: 'string' },
                    reason: 'type did not match',
                    consideredValue: 2,
                    consideredType: 'int',
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        operatorName: 'additionalProperties',
        specifiedAs: { additionalProperties: false },
        additionalProperties: ['extra'],
      },
      {
        operatorName: 'required',
        specifiedAs: { required: ['name', 'age'] },
        missingProperties: ['name'],
      },
    ],
  },
};

/** Recorded from MongoDB 8.0: a query-operator validator. */
const QUERY_FAILURE = {
  failingDocumentId: 'y',
  details: {
    operatorName: '$and',
    clausesNotSatisfied: [
      {
        index: 0,
        details: {
          operatorName: '$gt',
          specifiedAs: { a: { $gt: 5 } },
          reason: 'comparison failed',
          consideredValue: 1,
        },
      },
      {
        index: 1,
        details: {
          operatorName: '$exists',
          specifiedAs: { b: { $exists: true } },
          reason: 'path does not exist',
        },
      },
    ],
  },
};

describe('describeValidationFailure', () => {
  it('names the field and rule of each $jsonSchema failure', () => {
    expect(describeValidationFailure(JSON_SCHEMA_FAILURE)).toEqual([
      'name: minLength 2 (specified string length was not satisfied) value "x"',
      'age: bsonType int expected, got string value "old"',
      'tags[1]: bsonType string expected, got int value 2',
      'unexpected field: extra',
      'missing required field: name',
    ]);
  });

  it('describes query-operator validators', () => {
    expect(describeValidationFailure(QUERY_FAILURE)).toEqual([
      'a: {"$gt":5} (comparison failed) value 1',
      'b: {"$exists":true} (path does not exist)',
    ]);
    expect(describeValidationFailure(undefined)).toEqual([]);
  });
});

describe('mapMongoError', () => {
  it('maps server errors by code with hints', () => {
    expect(
      mapMongoError(
        serverError(18, 'Authentication failed.', { codeName: 'AuthenticationFailed' }),
        context,
      ),
    ).toMatchObject({
      code: 'AUTH_FAILED',
      message: 'Authentication failed at db.example.com:27017',
      engineCode: 'AuthenticationFailed',
      hint: expect.stringContaining('authSource'),
    });
    expect(
      mapMongoError(serverError(13, 'not authorized on x to execute command'), context),
    ).toMatchObject({
      code: 'SQL_ERROR',
      hint: expect.stringContaining('privilege'),
    });
    expect(mapMongoError(serverError(26, 'ns does not exist'), context).code).toBe('NOT_FOUND');
    expect(mapMongoError(serverError(50, 'operation exceeded time limit'), context).code).toBe(
      'TIMEOUT',
    );
    expect(mapMongoError(serverError(11601, 'operation was interrupted'), context).code).toBe(
      'CANCELLED',
    );
    expect(mapMongoError(serverError(112, 'Write conflict'), context).code).toBe('CONFLICT');
    expect(
      mapMongoError(
        serverError(251, 'no such transaction', { errorLabels: ['TransientTransactionError'] }),
        context,
      ).code,
    ).toBe('CONFLICT');
    expect(
      mapMongoError(
        serverError(40573, 'The $changeStream stage is only supported on replica sets'),
        context,
      ),
    ).toMatchObject({
      code: 'NOT_SUPPORTED',
      hint: expect.stringContaining('replica set'),
    });
    expect(mapMongoError(serverError(59, "no such command: 'x'"), context).code).toBe(
      'NOT_SUPPORTED',
    );
    expect(mapMongoError(serverError(2, 'BadValue'), context).code).toBe('SQL_ERROR');
  });

  it('describes validation failures and duplicate keys', () => {
    const validation = mapMongoError(
      serverError(121, 'Document failed validation', { errInfo: JSON_SCHEMA_FAILURE }),
      context,
    );
    expect(validation).toMatchObject({
      code: 'VALIDATION_FAILED',
      message:
        'Document failed validation: name: minLength 2 (specified string length was not satisfied) value "x"',
    });
    expect(validation.detail!.split('\n')).toHaveLength(5);
    const duplicate = mapMongoError(
      serverError(11000, 'E11000 duplicate key error', { keyValue: { k: 1 } }),
      context,
    );
    expect(duplicate).toMatchObject({ code: 'SQL_ERROR', detail: 'Duplicate key: {"k":1}' });
  });

  it('names the failing document of a bulk write', () => {
    const bulk = new MongoBulkWriteError(
      {
        message: 'Document failed validation',
        code: 121,
        writeErrors: [
          { index: 3, code: 121, errmsg: 'Document failed validation', errInfo: QUERY_FAILURE },
        ],
      } as never,
      { insertedCount: 3 } as never,
    );
    expect(mapMongoError(bulk, context)).toMatchObject({
      code: 'VALIDATION_FAILED',
      message: expect.stringContaining('(document 4)'),
    });
  });

  it('explains server selection failures by the topology behind them', () => {
    const refused = selectionError('Unknown', [
      {
        address: 'db.example.com:27017',
        type: 'Unknown',
        error: new MongoNetworkError('connect ECONNREFUSED', {
          cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
        }),
      },
    ]);
    expect(mapMongoError(refused, context)).toMatchObject({
      code: 'CONNECTION_FAILED',
      hint: expect.stringContaining('running'),
    });
    const tls = selectionError('Unknown', [
      {
        address: 'db.example.com:27017',
        type: 'Unknown',
        error: new MongoNetworkError('self-signed certificate', {
          cause: Object.assign(new Error('self-signed certificate in certificate chain'), {
            code: 'SELF_SIGNED_CERT_IN_CHAIN',
          }),
        }),
      },
    ]);
    expect(mapMongoError(tls, context)).toMatchObject({
      code: 'TLS_FAILED',
      hint: expect.stringContaining('CA certificate'),
    });
    const nameMismatch = selectionError('ReplicaSetNoPrimary', []);
    expect(
      mapMongoError(nameMismatch, { ...context, replicaSet: 'wrong', timeoutMs: 10000 }),
    ).toMatchObject({
      code: 'CONNECTION_FAILED',
      message: expect.stringContaining('No member of replica set "wrong"'),
      hint: expect.stringContaining('replica set name'),
    });
    const noPrimary = selectionError('ReplicaSetNoPrimary', [
      { address: 'mongo1:27017', type: 'Unknown' },
    ]);
    expect(mapMongoError(noPrimary, context)).toMatchObject({
      code: 'CONNECTION_FAILED',
      hint: expect.stringContaining('Direct connection'),
    });
    expect(
      mapMongoError(selectionError('Single', [{ address: 'x:1', type: 'Unknown' }]), {
        ...context,
        timeoutMs: 5000,
      }),
    ).toMatchObject({
      code: 'TIMEOUT',
      message:
        'No server was selectable within 5000 ms at db.example.com:27017 (topology Single; servers: x:1 Unknown)',
    });
  });

  it('maps client errors and never leaks secrets', () => {
    expect(
      mapMongoError(new MongoParseError('Invalid scheme in mongodb://ada:hunter2@h'), context),
    ).toMatchObject({
      code: 'VALIDATION_FAILED',
      message: 'Invalid scheme in mongodb://<credentials>@h',
    });
    const missing = new MongoMissingDependencyError(
      'Optional module `@aws-sdk/credential-providers` not found.',
      {
        dependencyName: '@aws-sdk/credential-providers',
      } as never,
    );
    expect(mapMongoError(missing, context)).toMatchObject({
      code: 'NOT_SUPPORTED',
      hint: expect.stringContaining('@aws-sdk/credential-providers'),
    });
    expect(JSON.stringify(mapMongoError(new Error('bad hunter2'), context))).not.toContain(
      'hunter2',
    );
    expect(mapMongoError(serverError(2, 'x'), { ...context, cancelRequested: true }).code).toBe(
      'CANCELLED',
    );
  });
});
