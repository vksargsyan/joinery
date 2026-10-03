import { EventEmitter } from 'node:events';

import type { CellValue } from '@querybara/core';
import type { FieldPacket, ResultSetHeader } from 'mysql2';
import { describe, expect, it } from 'vitest';

import { ResultStream, type CommandEvents } from '../src/stream';

class FakeConnection {
  paused = false;
  pauses = 0;
  pause(): void {
    this.paused = true;
    this.pauses += 1;
  }
  resume(): void {
    this.paused = false;
  }
}

const fields = (...names: string[]) => names.map((name) => ({ name }) as FieldPacket);
const header = (affectedRows: number) =>
  ({ affectedRows, insertId: 0, serverStatus: 2, warningStatus: 0 }) as ResultSetHeader;

function setup(pageSize: number) {
  const command = new EventEmitter();
  const connection = new FakeConnection();
  const stream = new ResultStream(connection, command as unknown as CommandEvents, pageSize);
  const row = (...values: CellValue[]) => command.emit('result', values);
  return { command, connection, stream, row };
}

describe('ResultStream', () => {
  it('hands out pages of rows and pauses the socket once a page is queued', async () => {
    const { command, connection, stream, row } = setup(2);
    command.emit('fields', fields('n'));
    row(1);
    expect(connection.paused).toBe(false);
    row(2);
    expect(connection.paused).toBe(true);
    row(3); // already in flight when the socket paused
    command.emit('end');

    expect(await stream.next()).toEqual({ kind: 'fields', fields: fields('n') });
    expect(await stream.next()).toEqual({ kind: 'rows', rows: [[1], [2]] });
    expect(connection.paused).toBe(false);
    expect(await stream.next()).toEqual({ kind: 'rows', rows: [[3]] });
    expect(await stream.next()).toBeNull();
    expect(stream.ended).toBe(true);
  });

  it('waits for rows that have not arrived yet', async () => {
    const { command, stream, row } = setup(3);
    command.emit('fields', fields('n'));
    await stream.next();
    const page = stream.next();
    row(1);
    row(2);
    setTimeout(() => {
      row(3);
    }, 5);
    expect(await page).toEqual({ kind: 'rows', rows: [[1], [2], [3]] });
  });

  it('keeps result sets apart and passes OK headers through', async () => {
    const { command, stream, row } = setup(10);
    command.emit('fields', fields('a'));
    row(1);
    command.emit('fields', fields('b', 'c'));
    row(2, 'x');
    command.emit('fields', undefined);
    command.emit('result', header(0));
    command.emit('end');
    const chunks = [];
    for (let chunk = await stream.next(); chunk !== null; chunk = await stream.next())
      chunks.push(chunk);
    expect(chunks.map((c) => c.kind)).toEqual(['fields', 'rows', 'fields', 'rows', 'header']);
    expect(chunks[1]).toEqual({ kind: 'rows', rows: [[1]] });
    expect(chunks[3]).toEqual({ kind: 'rows', rows: [[2, 'x']] });
  });

  it('fails a paused stream when the connection is lost', async () => {
    const { command, connection, stream, row } = setup(2);
    command.emit('fields', fields('n'));
    row(1);
    row(2);
    expect(connection.paused).toBe(true);
    await stream.next();
    // mysql2 tells only the connection that the socket died: the command never ends.
    const lost = new Error('Connection lost');
    stream.fail(lost);
    expect(await stream.next()).toEqual({ kind: 'rows', rows: [[1], [2]] });
    await expect(stream.next()).rejects.toBe(lost);
    expect(stream.ended).toBe(true);
    stream.fail(new Error('ignored once ended'));
  });

  it('delivers the rows before an error, then throws it', async () => {
    const { command, stream, row } = setup(10);
    command.emit('fields', fields('n'));
    row(1);
    command.emit('error', new Error('killed'));
    command.emit('end');
    await stream.next();
    expect(await stream.next()).toEqual({ kind: 'rows', rows: [[1]] });
    await expect(stream.next()).rejects.toThrow('killed');
  });

  it('discards the rest and resolves when the command ends', async () => {
    const { command, connection, stream, row } = setup(1);
    command.emit('fields', fields('n'));
    row(1);
    expect(connection.paused).toBe(true);
    const drained = stream.discardRest();
    expect(connection.paused).toBe(false);
    row(2);
    command.emit('end');
    await drained;
    expect(await stream.next()).toBeNull();
  });
});
