import {
  commandSafety as classifyCommand,
  isBsonDocument,
  parseShell,
  type BsonValue,
  type CommandSafety,
} from '@querybara/mongo-tools';

/**
 * What a command document typed in the MongoDB console does, for the write rules (spec §4, §6):
 * mongo-tools' classifier (shared with querybara-cli) on the parsed text. Text that is not a
 * command document counts as a read; the server says what is wrong with it.
 */

export type { CommandSafety };

/** Classifies console text; text that does not parse counts as a read (the server says why). */
export function commandSafety(text: string): CommandSafety {
  let value: BsonValue;
  try {
    value = parseShell(text);
  } catch {
    return { name: undefined, writes: false, destructive: false };
  }
  if (!isBsonDocument(value)) return { name: undefined, writes: false, destructive: false };
  return classifyCommand(value);
}
